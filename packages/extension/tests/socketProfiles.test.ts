import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TWITCH_IRC_CLIENT_COMMANDS, TWITCH_IRC_URL } from "@lurkloot/core/twitch/chatPresence";
import { forwardedFrame, socketProfileFor } from "../src/core/socketProfiles";

const CENTRIFUGO_URL = "wss://realtime.us-west-2.platform.kick.com/connection/websocket";
const PUSHER_URL =
  "wss://ws-us2.pusher.com/app/abc123?protocol=7&client=js&version=8.4.0&flash=false";

describe("socket profiles", () => {
  it("knows every platform socket the extension opens", () => {
    expect(
      socketProfileFor("wss://hermes.twitch.tv/v1?clientId=kimne78kx3ncx6brgo4mv6wki5h1ko"),
    ).toEqual({ name: "twitch-hermes", platform: "twitch", permission: "wss://*.twitch.tv/*" });
    expect(socketProfileFor(TWITCH_IRC_URL)).toEqual({
      name: "twitch-irc",
      platform: "twitch",
      permission: "wss://*.twitch.tv/*",
    });
    expect(socketProfileFor(CENTRIFUGO_URL)).toEqual({
      name: "kick-realtime",
      platform: "kick",
      permission: "wss://*.kick.com/*",
    });
    expect(socketProfileFor(PUSHER_URL)).toEqual({
      name: "kick-pusher",
      platform: "kick",
      permission: "wss://*.pusher.com/*",
    });
    expect(
      socketProfileFor("wss://websockets.kick.com/viewer/v1/connect?token=abc.def%2B"),
    ).toEqual({ name: "kick-viewer", platform: "kick", permission: "wss://*.kick.com/*" });
    // #798: the Fortnite extension's backend, behind its optional grant.
    expect(socketProfileFor("wss://backend.p-n6412w7dsu.exmggames.com/handler")).toEqual({
      name: "fortnite",
      platform: "twitch",
      permission: "wss://backend.p-n6412w7dsu.exmggames.com/*",
    });
    expect(forwardedFrame("fortnite", '{"type":"states.change"}')).toBe('{"type":"states.change"}');
  });

  it("refuses anything else", () => {
    for (const url of [
      "wss://evil.example/socket",
      "wss://backend.p-n6412w7dsu.exmggames.com/other",
      "wss://backend.p-n6412w7dsu.exmggames.com.evil.example/handler",
      "ws://irc-ws.chat.twitch.tv/",
      "wss://irc-ws.chat.twitch.tv.evil.example/",
      "wss://irc-ws.chat.twitch.tv/extra",
      "wss://hermes.twitch.tv/v1?clientId=abc&x=1",
      "wss://realtime.us-west-2.platform.kick.com.evil.example/connection/websocket",
      "wss://websockets.kick.com/viewer/v1/connect?token=a&other=b",
      `${PUSHER_URL}#fragment`,
    ]) {
      expect(socketProfileFor(url), url).toBeUndefined();
    }
  });
});

describe("forwarded frames", () => {
  it("forwards only the IRC commands chat presence reads", () => {
    const frame = [
      "PING :tmi.twitch.tv",
      "@badge-info=;color=#FF0000 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #channel :hello",
      ":lurker!lurker@lurker.tmi.twitch.tv JOIN #channel",
      "@emote-sets=0 :tmi.twitch.tv USERSTATE #channel",
      ":tmi.twitch.tv CLEARCHAT #channel :someone",
      "",
    ].join("\r\n");
    expect(forwardedFrame("twitch-irc", frame)).toBe(
      [
        "PING :tmi.twitch.tv",
        ":lurker!lurker@lurker.tmi.twitch.tv JOIN #channel",
        "@emote-sets=0 :tmi.twitch.tv USERSTATE #channel",
        "",
      ].join("\r\n"),
    );
    expect(forwardedFrame("twitch-irc", "@x=y :a!a@a PRIVMSG #c :spam\r\n")).toBeUndefined();
    expect(
      forwardedFrame("twitch-irc", ":tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv\r\n"),
    ).toBe(":tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv\r\n");
    expect(
      forwardedFrame("twitch-irc", ":tmi.twitch.tv 366 lurker #channel :End of /NAMES list\r\n"),
    ).toBeDefined();
    expect(forwardedFrame("twitch-irc", ":tmi.twitch.tv RECONNECT\r\n")).toBeDefined();
  });

  // The filter must never drop a command the client acts on.
  it("keeps every command the chat presence client handles", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, "../../core/src/platforms/twitch/chatPresence.ts"),
      "utf8",
    );
    const handled = [...source.matchAll(/case "([A-Z0-9]+)":/g)].map((match) => match[1]!);
    expect(handled.length).toBeGreaterThan(0);
    for (const command of handled)
      expect(TWITCH_IRC_CLIENT_COMMANDS.has(command), command).toBe(true);
  });

  // #755: discovery's drop channels cross; chat never does.
  it("forwards Kick drop-channel events and drops chat", () => {
    const drop =
      '{"push":{"channel":"drops_category_15","pub":{"data":{"event":"drops_campaign_started","data":"7"}}}}';
    expect(forwardedFrame("kick-realtime", drop)).toBe(drop);
    expect(forwardedFrame("kick-realtime", `{"push":{"channel":"chatrooms.1.v2"}}\n${drop}`)).toBe(
      drop,
    );
    expect(
      forwardedFrame("kick-realtime", '{"push":{"channel":"chatrooms.1.v2"}}'),
    ).toBeUndefined();
    expect(forwardedFrame("kick-realtime", '{"push":{}}\n{}\n{"id":2,"subscribe":{}}')).toBe(
      '{}\n{"id":2,"subscribe":{}}',
    );
    const pusherDrop =
      '{"event":"drops_campaign_started","data":"\\"7\\"","channel":"drops_category_15"}';
    expect(forwardedFrame("kick-pusher", pusherDrop)).toBe(pusherDrop);
    expect(
      forwardedFrame(
        "kick-pusher",
        '{"event":"pusher_internal:subscription_succeeded","channel":"x"}',
      ),
    ).toBeDefined();
    expect(
      forwardedFrame("kick-pusher", '{"event":"App\\\\Events\\\\ChatMessageEvent"}'),
    ).toBeUndefined();
    expect(forwardedFrame("kick-pusher", '{"event":"pusher:ping","data":{}}')).toBe(
      '{"event":"pusher:ping","data":{}}',
    );
  });

  it("forwards Hermes and the Kick viewer socket whole", () => {
    expect(forwardedFrame("twitch-hermes", '{"type":"keepalive"}')).toBe('{"type":"keepalive"}');
    expect(forwardedFrame("kick-viewer", '{"type":"pong"}')).toBe('{"type":"pong"}');
  });
});
