/**
 * Copyright 2023 Tigris Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  toConnectedEvent,
  toMessageEvent,
  toErrorEvent,
  createMessageEvent,
  toRealTimeMessage,
  createHeartbeatEvent,
  createDisconnectEvent,
  Encoding,
  createAttachEvent,
  createSubscribeEvent,
  createDetachEvent,
  createUnsubscribeEvent,
} from "./messages";
import { EventEmitter } from "eventemitter3";
import * as proto from "../proto/server/v1/realtime";
import Logger from "./logger";
import { Newable } from "./utils";

type MessageEventListener = (MessageEvent: proto.MessageEvent) => void;

class ChannelState {
  listeners: MessageEventListener[] = [];
  position: string = "";
}

interface TransportConfig {
  heartbeatTimeout: number;
  WebSocket: Newable<WebSocket>;
  url: string;
  logger: Logger;
  autoconnect: boolean;
  encoding: Encoding;
}

class Session {
  sessionId: string;
  socketId: string;

  constructor(connected: proto.ConnectedEvent) {
    this.sessionId = connected.session_id;
    this.socketId = connected.socket_id;
  }
}

type ConnectionState =
  | "failed"
  | "connecting"
  | "connected"
  | "error"
  | "uninitialized"
  | "closing"
  | "closed";

export type ConnectError = proto.ErrorEvent;

export type ConnectionEventFn = () => void;
export type ConnectionErrorFn = (error: ConnectError) => void;

export type ConnectionEvent =
  | "failed"
  | "connecting"
  | "connected"
  | "closing"
  | "closed";

export declare interface Transport {
  on(event: "error", listener: (error: ConnectError) => void): this;
  on(event: ConnectionEvent, listener: () => void): this;
}

export class Transport extends EventEmitter {
  private channelsState: Map<string, ChannelState>;
  private ws: WebSocket;
  private session?: Session;
  private _connectionState: ConnectionState = "uninitialized";
  private heartbeatId: number | NodeJS.Timeout = 0;
  private config: TransportConfig;
  private encoding: Encoding;

  private maxRetries = 10;
  private connectionRetries = 0;
  private logger: Logger;
  private reconnectId: number | NodeJS.Timeout = 0;
  private msgQueue: (Uint8Array | string)[] = [];

  constructor(config: TransportConfig) {
    super();

    this.config = config;
    this.logger = config.logger;
    this.channelsState = new Map();
    this.encoding = config.encoding;

    this.on("connected", () => {
      this.logger.debug("sending stored messages and resubscribes");
      this.reconnectChannels();
      this.sendQueuedMessages();
    });

    if (config.autoconnect) {
      this.establishConnection();
    }
  }

  setConnectionState(newState: ConnectionState, error?: ConnectError) {
    this.logger.debug(
      `state changed from ${this._connectionState} to ${newState}`
    );
    this._connectionState = newState;

    if (newState === "error") {
      this.emit("error", error);
    } else {
      this.emit(newState as ConnectionEvent);
    }
  }

  establishConnection() {
    const encoding = this.encoding === Encoding.msgpack ? "msgpack" : "json";
    let params = `user-agent=FIX_ME&protocol=1&encoding=${encoding}`;
    if (this.session?.sessionId) {
      params += `&sessionId=${this.session.sessionId}&`;
    }

    this.logger.info("connecting to ", this.config.url);
    this.ws = new this.config.WebSocket(`${this.config.url}?${params}`);
    this.ws.binaryType = "arraybuffer";
    this.setConnectionState("connecting");

    this.ws.onopen = () => this.restartHeartbeat();
    this.ws.onerror = (err) => {
      // @ts-ignore
      this.onError(err.message);
    };
    this.ws.onclose = (_event) => this.onClose();
    this.ws.onmessage = (msg: MessageEvent<Uint8Array>) =>
      this.onMessage(msg.data);
  }

  onClose() {
    this.logger.debug("server connection closed");
    this.clearHearbeat();
    if (this._connectionState === "closing") {
      this.setConnectionState("closed");
      return;
    }

    this.connectionRetries += 1;

    if (this.connectionRetries <= this.maxRetries) {
      this.logger.info("reconnecting to server");
      this.reconnectId = setTimeout(
        () => this.establishConnection(),
        // Exponential backoff taken from https://bpaulino.com/entries/retrying-api-calls-with-exponential-backoff
        // (2 ** 1) * 100 = 200 ms
        // (2 ** 2) * 100 = 400 ms
        // (2 ** 3) * 100 = 800 ms
        2 ** this.connectionRetries * 100
      );
    } else {
      this.emit("failed");
      this._connectionState = "failed";
    }
  }

  onError(err: string) {
    this.logger.error(err);
    this._connectionState = "error";
    this.emit("error", { code: null, message: err });
  }

  onMessage(data: ArrayLike<number> | string) {
    const msg = toRealTimeMessage(this.encoding, data);

    this.logger.debug("message received", msg.event_type);

    switch (msg.event_type) {
      case proto.EventType.ack:
        return;
      case proto.EventType.connected:
        this.session = new Session(toConnectedEvent(this.encoding, msg.event));
        this.logger.debug("connected as", this.session);
        this.setConnectionState("connected");
        this.connectionRetries = 0;
        this.restartHeartbeat();
        return;
      case proto.EventType.heartbeat:
        return;
      case proto.EventType.subscribed:
        this.logger.info("subscribed");
        return;
      case proto.EventType.message:
        let channelMsg = toMessageEvent(this.encoding, msg.event);
        this.handleChannelMessage(channelMsg);
        return;
      case proto.EventType.error:
        let error = toErrorEvent(this.encoding, msg.event);
        this.emit("error", error);
        this.logger.error("recieved ", error);
        return;
      default:
        throw new Error(`unknown message type ${msg.event_type}`);
    }
  }

  clearHearbeat() {
    clearTimeout(this.heartbeatId);
  }
  restartHeartbeat() {
    this.clearHearbeat();
    this.heartbeatId = setTimeout(
      () => this.sendHeartbeat(),
      this.config.heartbeatTimeout
    );
  }

  send(msg: Uint8Array | string, saveOffline = false) {
    if (this._connectionState !== "connected" && saveOffline) {
      this.msgQueue.push(msg);
    } else {
      this.restartHeartbeat();
      try {
        this.ws.send(msg);
      } catch (error) {
        let message;
        if (error instanceof Error) message = error.message;
        else message = String(error);

        if (/WebSocket is not open/.test(message) && saveOffline) {
          this.msgQueue.push(msg);
        }

        this.logger.error(message);
      }
    }
  }

  sendHeartbeat() {
    this.logger.debug("sending heartbeat");
    this.restartHeartbeat();
    this.ws.send(createHeartbeatEvent(this.encoding));
  }

  sendDisconnect() {
    this.logger.debug("sending disconnect");
    this.send(createDisconnectEvent(this.encoding));
  }

  connectionState(): ConnectionState {
    return this._connectionState;
  }

  handleChannelMessage(msg: proto.MessageEvent) {
    const channelState = this.channelsState.get(msg.channel);

    if (!channelState) {
      let error = {
        code: 0,
        message: `received msg for channel ${msg.channel} that doesn't exist`,
      };
      this.logger.error(error.message);
      this.emit("error", error);
      return;
    }

    channelState.position = msg.id;
    channelState.listeners.forEach((listener) => listener(msg));
  }

  listen(channelName: string, listener: MessageEventListener) {
    if (!this.channelsState.has(channelName)) {
      this.channelsState.set(channelName, new ChannelState());
    }

    const channelState = this.channelsState.get(channelName);

    if (!channelState) {
      return;
    }

    channelState.listeners.push(listener);
  }

  attach(channelName: string) {
    this.logger.debug("sending attach from ", channelName);
    this.send(createAttachEvent(this.encoding, channelName));
  }

  detach(channelName: string) {
    this.logger.debug("sending detach");
    this.send(createDetachEvent(this.encoding, channelName));
  }

  subscribe(channelName: string, name: string, position: string) {
    this.logger.debug("sending subscribe", channelName);
    this.send(createSubscribeEvent(this.encoding, channelName, name, position));
  }

  unsubscribe(channelName: string) {
    this.logger.debug("sending unsubscribe", channelName);
    this.send(createUnsubscribeEvent(this.encoding, channelName));
  }

  async publish(channel: string, name: string, message: any) {
    this.logger.debug("publish msg", channel, name, message);
    const msg = createMessageEvent(this.encoding, channel, name, message);
    this.send(msg, true);
  }

  // Returns the connection session socket id
  socketId(): string | undefined {
    return this.session?.sessionId;
  }

  reconnectChannels() {
    this.channelsState.forEach((state, name) => {
      this.attach(name);
      this.subscribe(name, "", state.position);
    });
  }

  sendQueuedMessages() {
    this.msgQueue.forEach((msg) => {
      this.send(msg, true);
    });
  }

  close() {
    this.logger.info("transport closing");
    this.sendDisconnect();
    this.setConnectionState("closing");
    this.clearHearbeat();
    clearTimeout(this.reconnectId);
    this.ws.close();
  }
}
