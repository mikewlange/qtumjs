import { IABIMethod, IETHABI, LogDecoder } from "./ethjs-abi"
import { EventEmitter } from "eventemitter3"

const {
  logDecoder,
} = require("ethjs-abi") as IETHABI

import {
  decodeLogs,
  decodeOutputs,
  encodeInputs,
  ContractLogDecoder,
} from "./abi"

import { IDecodedLog, ITransactionLog, IRPCSearchLogsRequest } from "./index"
import {
  IExecutionResult,
  IRPCCallContractResult,
  IRPCGetTransactionReceiptBase,
  IRPCGetTransactionReceiptResult,
  IRPCGetTransactionResult,
  IRPCSendToContractResult,
  IRPCWaitForLogsResult,
  QtumRPC,
  IRPCWaitForLogsRequest,
  ILogEntry,
} from "./QtumRPC"
import {
  TxReceiptConfirmationHandler,
  TxReceiptPromise,
} from "./TxReceiptPromise"

export interface IContractSendTx {
  method: string
  txid: string
}

export type IContractSendTxConfirmationHandler = (
  tx: IRPCGetTransactionResult,
  receipt: IContractSendTxReceipt,
) => any

export type IContractSendTxConfirmFunction = (n?: number, handler?: IContractSendTxConfirmationHandler) => any

export interface IContractSendTxConfirmable extends IRPCGetTransactionResult {
  method: string
  confirm: IContractSendTxConfirmFunction,
}

export interface IContractInfo {
  /**
   * Contract ABI methods
   */
  abi: IABIMethod[]
  /**
   * Address of contract
   */
  address: string

  // name: string
  // deployName: string
  // txid: string
  // bin: string
  // binhash: string
  // createdAt: string // date string
  // confirmed: boolean

  sender?: string
}

// IDeployedContractInfo has extra deployment information stored by solar
export interface IDeployedContractInfo extends IContractInfo {
  name: string
  deployName: string
  txid: string
  bin: string
  binhash: string
  createdAt: string // date string
  confirmed: boolean
}

export interface IContractCallDecodedResult extends IRPCCallContractResult {
  outputs: any[]
  // [key: number]: any
}

export interface IContractSendRequestOptions {
  /**
   * The amount in QTUM to send. eg 0.1, default: 0
   */
  amount?: number | string

  /**
   * gasLimit, default: 200000, max: 40000000
   */
  gasLimit?: number

  /**
   * Qtum price per gas unit, default: 0.00000001, min:0.00000001
   */
  gasPrice?: number | string

  /**
   * The quantum address that will be used as sender.
   */
  senderAddress?: string
}

export interface IContractCallRequestOptions {
  /**
   * The quantum address that will be used as sender.
   */
  senderAddress?: string
}

export interface IContractSendTxReceipt extends IRPCGetTransactionReceiptBase {
  /**
   * logs decoded using ABI
   */
  logs: IDecodedLog[],

  /**
   * undecoded logs
   */
  rawlogs: ITransactionLog[],
}

export interface IContractLog<T> extends ILogEntry {
  event: T
}

export interface IContractLogEntry extends ILogEntry {
  event: IDecodedLog | null,
}

export interface IContractLogs {
  entries: IContractLogEntry[],
  count: number,
  nextblock: number,
}

export class Contract {

  // private abi: IABI[]
  public address: string
  private callMethodsMap: { [key: string]: IABIMethod } = {}
  private sendMethodsMap: { [key: string]: IABIMethod } = {}
  private _logDecoder: ContractLogDecoder

  constructor(private rpc: QtumRPC, public info: IContractInfo) {
    for (const methodABI of info.abi) {
      const name = methodABI.name

      // Allow sendToContract only for non-constant methods
      if (!methodABI.constant) {
        this.sendMethodsMap[name] = methodABI
      }

      this.callMethodsMap[name] = methodABI
    }

    this.address = info.address
  }

  public encodeParams(method: string, args: any[] = []): string {
    const methodABI = this.callMethodsMap[method]
    if (methodABI == null) {
      throw new Error(`Unknown method to call: ${method}`)
    }

    return encodeInputs(methodABI, args)
  }

  /**
   * Call a contract method using ABI encoding, and return the RPC result as is. This
   * does not create a transaction. It is useful for gas estimation or getting results from
   * read-only methods.
   *
   * @param method name of contract method to call
   * @param args arguments
   */
  public async rawCall(
    method: string, args: any[] = [],
    opts: IContractCallRequestOptions = {}):
    Promise<IRPCCallContractResult> {
    // TODO opts: sender address

    // need to strip the leading "0x"
    const calldata = this.encodeParams(method, args)

    // TODO decode?
    return this.rpc.callContract({
      address: this.address,
      datahex: calldata,
      senderAddress: opts.senderAddress || this.info.sender,
      ...opts,
    })
  }

  public async call(
    method: string,
    args: any[] = [],
    opts: IContractCallRequestOptions = {}):
    Promise<IContractCallDecodedResult> {
    // TODO support the named return values mechanism for decodeParams

    const r = await this.rawCall(method, args, opts)

    const exception = r.executionResult.excepted
    if (exception !== "None") {
      throw new Error(`Call exception: ${exception}`)
    }

    const output = r.executionResult.output

    let decodedOutputs = []
    if (output !== "") {
      const methodABI = this.callMethodsMap[method]
      decodedOutputs = decodeOutputs(methodABI, output)
    }

    return Object.assign(r, {
      outputs: decodedOutputs,
    })
  }

  /**
   * Create a transaction that calls a method using ABI encoding, and return the RPC result as is.
   * A transaction will require network consensus to confirm, and costs you gas.
   *
   * @param method name of contract method to call
   * @param args arguments
   */
  public async rawSend(
    method: string,
    args: any[],
    opts: IContractSendRequestOptions = {}):
    Promise<IRPCSendToContractResult> {
    // TODO opts: gas limit, gas price, sender address
    const methodABI = this.sendMethodsMap[method]
    if (methodABI == null) {
      throw new Error(`Unknown method to send: ${method}`)
    }

    const calldata = encodeInputs(methodABI, args)

    return this.rpc.sendToContract({
      address: this.address,
      datahex: calldata,
      senderAddress: opts.senderAddress || this.info.sender,
      ...opts,
    })
  }

  public async confirm(
    tx: IContractSendTx,
    confirm?: number,
    onConfirm?: IContractSendTxConfirmationHandler,
  ): Promise<IContractSendTxReceipt> {
    const txrp = new TxReceiptPromise(this.rpc, tx.txid)

    if (onConfirm) {
      txrp.onConfirm((tx2, receipt2) => {
        const sendTxReceipt = this._makeSendTxReceipt(receipt2)
        onConfirm(tx2, sendTxReceipt)
      })
    }

    const receipt = await txrp.confirm(confirm)

    return this._makeSendTxReceipt(receipt)
  }

  public async send(
    method: string,
    args: any[],
    opts: IContractSendRequestOptions = {},
  ): Promise<IContractSendTxConfirmable> {
    const methodABI = this.sendMethodsMap[method]

    if (methodABI == null) {
      throw new Error(`Unknown method to send: ${method}`)
    }

    const calldata = encodeInputs(methodABI, args)

    const sent = await this.rpc.sendToContract({
      datahex: calldata,
      address: this.address,
      senderAddress: opts.senderAddress || this.info.sender,
      ...opts,
    })

    const txid = sent.txid

    const txinfo = await this.rpc.getTransaction({txid})

    const sendTx = {
      ...txinfo,
      method,
      confirm: (n?: number, handler?: IContractSendTxConfirmationHandler) => {
        return this.confirm(sendTx, n, handler)
      },
    }

    return sendTx
  }

  public async logs(req: IRPCWaitForLogsRequest = {}): Promise<IContractLogs> {
    const filter = req.filter || {}
    if (!filter.addresses) {
      filter.addresses = [this.address]
    }

    const result = await this.rpc.waitforlogs({
      ...req,
      filter,
    })

    const entries = result.entries.map((entry) => {
      const parsedLog = this.logDecoder.decode(entry)
      return {
        ...entry,
        event: parsedLog,
       }
    })

    return {
      ...result,
      entries,
    }
  }

  public onLog(fn: (entry: IContractLogEntry) => void, opts: IRPCWaitForLogsRequest = {}) {
    let nextblock = opts.from || "latest"

    const loop = async () => {
      while (true) {
        const result = await this.logs({
          ...opts,
          from: nextblock,
        })

        for (const entry of result.entries) {
          fn(entry)
        }

        nextblock = result.nextblock
      }
    }

    loop()
  }

  /**
   * events API for getting logs
   *
   * logs = token.logEmitter({ minconf: 1 })
   *
   * logs.on("Mint", (logEntry: IContractLogEntry) => {
   *   // ...
   * })
   *
   * logs.on("Transfer", (logEntry: IContractLogEntry) => {
   *   // ...
   * })
   *
   * logs.on("?", () => {
   *   // catch all for unparsed events not defined in ABI
   * })
   *
   */
  public logEmitter(opts: IRPCWaitForLogsRequest = {}): EventEmitter {
    const emitter = new EventEmitter()

    this.onLog((entry) => {
      const key = (entry.event && entry.event.type) || "?"
      emitter.emit(key, entry)
    }, opts)

    return emitter
  }

  private get logDecoder(): ContractLogDecoder {
    if (this._logDecoder) {
      return this._logDecoder
    }

    this._logDecoder = new ContractLogDecoder(this.info.abi)
    return this._logDecoder
  }

  private _makeSendTxReceipt(receipt: IRPCGetTransactionReceiptResult): IContractSendTxReceipt {
    // https://stackoverflow.com/a/34710102
    // ...receiptNoLog will be a copy of receipt, without the `log` property
    const {log: rawlogs, ...receiptNoLog} = receipt
    const logs = decodeLogs(this.info.abi, rawlogs)

    return {
      ...receiptNoLog,
      logs,
      rawlogs,
    }
  }
}
