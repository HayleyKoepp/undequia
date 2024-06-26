import { CustomEvent, EventEmitter } from "@libp2p/interface/events";
import type {
  PeerDiscovery,
  PeerDiscoveryEvents
} from "@libp2p/interface/peer-discovery";
import { peerDiscovery as symbol } from "@libp2p/interface/peer-discovery";
import type { PeerInfo } from "@libp2p/interface/peer-info";
import type {
  DnsDiscOptions,
  DnsDiscoveryComponents,
  IEnr,
  NodeCapabilityCount
} from "@waku/interfaces";
import debug from "debug";

import {
  DEFAULT_BOOTSTRAP_TAG_NAME,
  DEFAULT_BOOTSTRAP_TAG_TTL,
  DEFAULT_BOOTSTRAP_TAG_VALUE,
  DEFAULT_NODE_REQUIREMENTS
} from "./constants.js";
import { DnsNodeDiscovery } from "./dns.js";

const log = debug("waku:peer-discovery-dns");

/**
 * Parse options and expose function to return bootstrap peer addresses.
 */
export class PeerDiscoveryDns
  extends EventEmitter<PeerDiscoveryEvents>
  implements PeerDiscovery
{
  private nextPeer: (() => AsyncGenerator<IEnr>) | undefined;
  private _started: boolean;
  private _components: DnsDiscoveryComponents;
  private _options: DnsDiscOptions;

  constructor(components: DnsDiscoveryComponents, options: DnsDiscOptions) {
    super();
    this._started = false;
    this._components = components;
    this._options = options;

    const { enrUrls } = options;
    log("Use following EIP-1459 ENR Tree URLs: ", enrUrls);
  }

  /**
   * Start discovery process
   */
  async start(): Promise<void> {
    log("Starting peer discovery via dns");

    this._started = true;

    if (this.nextPeer === undefined) {
      let { enrUrls } = this._options;
      if (!Array.isArray(enrUrls)) enrUrls = [enrUrls];

      const { wantedNodeCapabilityCount } = this._options;
      const dns = await DnsNodeDiscovery.dnsOverHttp();

      this.nextPeer = dns.getNextPeer.bind(
        dns,
        enrUrls,
        wantedNodeCapabilityCount
      );
    }

    for await (const peerEnr of this.nextPeer()) {
      if (!this._started) {
        return;
      }

      const peerInfo = peerEnr.peerInfo;

      if (!peerInfo) {
        continue;
      }

      const tagsToUpdate = {
        tags: {
          [DEFAULT_BOOTSTRAP_TAG_NAME]: {
            value: this._options.tagValue ?? DEFAULT_BOOTSTRAP_TAG_VALUE,
            ttl: this._options.tagTTL ?? DEFAULT_BOOTSTRAP_TAG_TTL
          }
        }
      };

      let isPeerChanged = false;
      const isPeerExists = await this._components.peerStore.has(peerInfo.id);

      if (isPeerExists) {
        const peer = await this._components.peerStore.get(peerInfo.id);
        const hasBootstrapTag = peer.tags.has(DEFAULT_BOOTSTRAP_TAG_NAME);

        if (!hasBootstrapTag) {
          isPeerChanged = true;
          await this._components.peerStore.merge(peerInfo.id, tagsToUpdate);
        }
      } else {
        isPeerChanged = true;
        await this._components.peerStore.save(peerInfo.id, tagsToUpdate);
      }

      if (isPeerChanged) {
        this.dispatchEvent(
          new CustomEvent<PeerInfo>("peer", { detail: peerInfo })
        );
      }
    }
  }

  /**
   * Stop emitting events
   */
  stop(): void {
    this._started = false;
  }

  get [symbol](): true {
    return true;
  }

  get [Symbol.toStringTag](): string {
    return "@waku/bootstrap";
  }
}

export function wakuDnsDiscovery(
  enrUrls: string[],
  wantedNodeCapabilityCount: Partial<NodeCapabilityCount> = DEFAULT_NODE_REQUIREMENTS
): (components: DnsDiscoveryComponents) => PeerDiscoveryDns {
  return (components: DnsDiscoveryComponents) =>
    new PeerDiscoveryDns(components, { enrUrls, wantedNodeCapabilityCount });
}
