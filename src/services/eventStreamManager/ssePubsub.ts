import { Request, Response } from "express";
import logger from "../logger";
import { Context } from "../../types";

/**
 * Originally forked from sse-pubsub:
 *   https://www.npmjs.com/package/sse-pubsub
 *   Copyright for portions of project GrowthBook Proxy are held by Andrew Betts, 2017
 *   All other copyright is held by GrowthBook, Inc., 2022
 */

export interface Options {
  pingInterval: number;
  maxStreamDuration: number;
  clientRetryInterval: number;
  startId: number;
  historySize: number;
  rewind: number;
}

interface Connection {
  req: Request;
  res: Response;
  events?: (string | RegExp)[];
}
interface Message {
  id: number;
  eventName: string;
  output: string;
}

export class SSEChannel {
  private nextID = 1;
  private clients: Set<Connection> = new Set();
  private messages: Message[] = [];
  private active = true;

  private pingTimer: NodeJS.Timeout | null = null;

  private options: Options;
  private appContext?: Context;

  constructor(
    {
      pingInterval = 30000,
      maxStreamDuration = 0,
      clientRetryInterval = 10000,
      startId = 1,
      historySize = 1,
      rewind = 0,
    }: Partial<Options>,
    appContext?: Context
  ) {
    this.options = {
      pingInterval,
      maxStreamDuration,
      clientRetryInterval,
      startId,
      historySize,
      rewind,
    };
    this.appContext = appContext;

    this.nextID = this.options.startId;

    if (this.options.pingInterval) {
      this.pingTimer = setInterval(
        () => this.publish(),
        this.options.pingInterval
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public publish(data?: any, eventName?: string) {
    this.appContext?.verboseDebugging &&
      logger.info(
        { eventName: eventName || "[ping]", clients: this.clients.size },
        "ssePubsub.subscribe: publish"
      );
    if (!this.active) {
      logger.warn("ssePubsub.publish: Channel closed");
    }
    let output = "";
    let id;
    if (!data && !eventName) {
      if (!this.clients.size) {
        // No need to create a ping entry if there are no clients connected
        return;
      }
      output = "data: \n\n";
    } else {
      id = this.nextID++;
      if (typeof data === "object") {
        data = JSON.stringify(data);
      }
      data = data
        ? (data + "")
            .split(/[\r\n]+/)
            .map((str) => "data: " + str)
            .join("\n")
        : "";
      output =
        `id: ${id} \n` +
        (eventName ? `event: ${eventName}` + "\n" : "") +
        (data || "data: ") +
        "\n\n";

      eventName = eventName || "";
      this.messages.push({ id, eventName, output });
    }

    [...this.clients]
      .filter(
        (c) =>
          !eventName || !c.events || this.hasEventMatch(c.events, eventName)
      )
      .forEach((c) => c.res.write(output));

    while (this.messages.length > this.options.historySize) {
      this.messages.shift();
    }

    return id;
  }

  public subscribe(req: Request, res: Response, events?: (string | RegExp)[]) {
    this.appContext?.verboseDebugging &&
      logger.info("ssePubsub.subscribe: subscribe");
    if (!this.active) {
      logger.warn("ssePubsub.subscribe: Channel closed");
    }
    const c: Connection = { req, res, events };
    c.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    c.res.flushHeaders();
    let body = `retry: ${this.options.clientRetryInterval}\n\n`;

    const lastID = req.headers["last-event-id"]
      ? Number.parseInt(req.headers["last-event-id"] + "", 10)
      : NaN;
    const rewind = !Number.isNaN(lastID)
      ? this.nextID - 1 - lastID
      : this.options.rewind;
    if (rewind) {
      this.messages
        .filter((m) =>
          c.events ? this.hasEventMatch(c.events, m.eventName) : true
        )
        .slice(0 - rewind)
        .forEach((m) => {
          body += m.output;
        });
    }

    c.res.write(body);
    this.clients.add(c);

    if (this.options.maxStreamDuration) {
      setTimeout(() => {
        if (!c.res.finished) {
          this.appContext?.verboseDebugging &&
            logger.info("ssePubsub.subscribe: unsubscribe via timeout");
          this.unsubscribe(c);
        }
      }, this.options.maxStreamDuration);
    }

    c.res.on("close", () => {
      this.appContext?.verboseDebugging &&
        logger.info("ssePubsub.subscribe: unsubscribe via response close");
      this.unsubscribe(c);
    });

    c.res.on("error", (err) => {
      this.appContext?.verboseDebugging &&
        logger.warn(err, "ssePubsub.subscribe: response error");
    });

    c.res.on("finish", () => {
      this.appContext?.verboseDebugging &&
        logger.info("ssePubsub.subscribe: response finish");
    });

    return c;
  }

  public unsubscribe(c: Connection) {
    this.appContext?.verboseDebugging && logger.info("ssePubsub.unsubscribe");
    c.res.end();
    this.clients.delete(c);
  }

  public close() {
    this.clients.forEach((c) => c.res.end());
    this.clients = new Set();
    this.messages = [];
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.active = false;
  }

  public listClients() {
    const rollupByIP: Record<string, number> = {};
    this.clients.forEach((c) => {
      const ip = c.req?.connection?.remoteAddress
        ? c.req.connection.remoteAddress + ""
        : "unknown";
      if (!(ip in rollupByIP)) {
        rollupByIP[ip] = 0;
      }
      rollupByIP[ip]++;
    });
    return rollupByIP;
  }

  public getSubscriberCount() {
    return this.clients.size;
  }

  private hasEventMatch(
    subscriptionList: (string | RegExp)[],
    eventName: string
  ) {
    return (
      !subscriptionList ||
      subscriptionList.some((pat) =>
        pat instanceof RegExp ? pat.test(eventName) : pat === eventName
      )
    );
  }
}
