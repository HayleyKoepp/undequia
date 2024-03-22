import type { PeerId } from "@libp2p/interface/peer-id";
import {
  IEncoder,
  ILightPush,
  IMessage,
  Libp2p,
  ProtocolCreateOptions,
  SendError,
  SendResult
} from "@waku/interfaces";
import { PushResponse } from "@waku/proto";
import { isSizeValid } from "@waku/utils";
import debug from "debug";
import all from "it-all";
import * as lp from "it-length-prefixed";
import { pipe } from "it-pipe";
import { Uint8ArrayList } from "uint8arraylist";

import { BaseProtocol } from "../base_protocol.js";
import { DefaultPubSubTopic } from "../constants.js";

import { PushRpc } from "./push_rpc.js";

const log = debug("waku:light-push");

export const LightPushCodec = "/vac/waku/lightpush/2.0.0-beta1";
export { PushResponse };

type PreparePushMessageResult =
  | {
      query: PushRpc;
      error: null;
    }
  | {
      query: null;
      error: SendError;
    };

/**
 * Implements the [Waku v2 Light Push protocol](https://rfc.vac.dev/spec/19/).
 */
class LightPush extends BaseProtocol implements ILightPush {
  options: ProtocolCreateOptions;
  private readonly NUM_PEERS_PROTOCOL = 1;

  constructor(libp2p: Libp2p, options?: ProtocolCreateOptions) {
    super(LightPushCodec, libp2p.components);
    this.options = options || {};
  }

  private async preparePushMessage(
    encoder: IEncoder,
    message: IMessage,
    pubSubTopic: string
  ): Promise<PreparePushMessageResult> {
    try {
      if (!isSizeValid(message.payload)) {
        log("Failed to send waku light push: message is bigger than 1MB");
        return { query: null, error: SendError.SIZE_TOO_BIG };
      }

      const protoMessage = await encoder.toProtoObj(message);
      if (!protoMessage) {
        log("Failed to encode to protoMessage, aborting push");
        return {
          query: null,
          error: SendError.ENCODE_FAILED
        };
      }

      const query = PushRpc.createRequest(protoMessage, pubSubTopic);
      return { query, error: null };
    } catch (error) {
      log("Failed to prepare push message", error);

      return {
        query: null,
        error: SendError.GENERIC_FAIL
      };
    }
  }

  async send(encoder: IEncoder, message: IMessage): Promise<SendResult> {
    const { pubSubTopic = DefaultPubSubTopic } = this.options;
    const recipients: PeerId[] = [];

    const { query, error: preparationError } = await this.preparePushMessage(
      encoder,
      message,
      pubSubTopic
    );

    if (preparationError || !query) {
      return {
        recipients,
        errors: [preparationError]
      };
    }

    const peers = await this.getPeers({
      maxBootstrapPeers: 1,
      numPeers: this.NUM_PEERS_PROTOCOL
    });

    const promises = peers.map(async (peer) => {
      let error: SendError | undefined;
      const stream = await this.getStream(peer);

      try {
        const res = await pipe(
          [query.encode()],
          lp.encode,
          stream,
          lp.decode,
          async (source) => await all(source)
        );
        try {
          const bytes = new Uint8ArrayList();
          res.forEach((chunk) => {
            bytes.append(chunk);
          });

          const response = PushRpc.decode(bytes).response;

          if (response?.isSuccess) {
            recipients.some((recipient) => recipient.equals(peer.id)) ||
              recipients.push(peer.id);
          } else {
            log("No response in PushRPC");
            error = SendError.NO_RPC_RESPONSE;
          }
        } catch (err) {
          log("Failed to decode push reply", err);
          error = SendError.DECODE_FAILED;
        }
      } catch (err) {
        log("Failed to send waku light push request", err);
        error = SendError.GENERIC_FAIL;
      }

      return { recipients, error };
    });

    const results = await Promise.allSettled(promises);
    const errors = results
      .filter(
        (
          result
        ): result is PromiseFulfilledResult<{
          recipients: PeerId[];
          error: SendError | undefined;
        }> => result.status === "fulfilled"
      )
      .map((result) => result.value.error)
      .filter((error) => error !== undefined) as SendError[];

    return {
      recipients,
      errors
    };
  }
}

export function wakuLightPush(
  init: Partial<ProtocolCreateOptions> = {}
): (libp2p: Libp2p) => ILightPush {
  return (libp2p: Libp2p) => new LightPush(libp2p, init);
}
