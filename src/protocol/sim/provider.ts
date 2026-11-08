import { JsonRpcApiProvider, Network, type JsonRpcError, type JsonRpcPayload, type JsonRpcResult } from 'ethers'
import type { RpcPayload, SimChain } from './engine'

/** An ethers provider whose "node" is the in-browser EVM. No network requests are made. */
export class SimProvider extends JsonRpcApiProvider {
  constructor(private readonly chain: SimChain) {
    const network = Network.from({ chainId: chain.chainId, name: 'rixor-browser-evm' })
    // cacheTimeout -1: never reuse a cached response (consecutive transactions need fresh nonces).
    super(network, { staticNetwork: network, batchMaxCount: 1, pollingInterval: 250, cacheTimeout: -1 })
  }

  async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<(JsonRpcResult | JsonRpcError)[]> {
    const list = Array.isArray(payload) ? payload : [payload]
    const out = await Promise.all(list.map((p) => this.chain.rpc(p as unknown as RpcPayload)))
    return out as (JsonRpcResult | JsonRpcError)[]
  }
}
