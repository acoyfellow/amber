import { Context, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc";
import { ProgramRpcs, RPC_PATH } from "../../shared/protocol";

type ProgramRpcClient = RpcClient.FromGroup<typeof ProgramRpcs, RpcClientError.RpcClientError>;

export class ProgramClient extends Context.Service<ProgramClient, ProgramRpcClient>()("amber/ProgramClient") {}

const protocol = RpcClient.layerProtocolHttp({ url: RPC_PATH }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]));

export const ProgramClientLive = Layer.effect(ProgramClient, RpcClient.make(ProgramRpcs)).pipe(Layer.provide(protocol));
