const {Class} = require("sdk/core/heritage");
//const {prefs} = require("sdk/simple-prefs");
const prefs = { logDevToolsProtocolTraffic: true };
const task = require("../util/task");
const {Pool} = require("devtools/server/protocol");
const {DebuggerTransport, LocalDebuggerTransport} = require("devtools/shared/transport/transport");
const DevToolsUtils = require("devtools/shared/DevToolsUtils");
const {ChromiumRootActor, requestTabs} = require("./root");

//const {when: unload} = require("sdk/system/unload");

let connID = 1;
let connections = new Set();

var Connection = Class({
  extends: Pool,

  initialize: function(prefix, transport, url) {
    this.url = url;
    this.prefix = prefix + ".";
    this.transport = transport;
    this.nextID = 1;
    transport.hooks = this;
    this.root = new ChromiumRootActor(this, url);
    this.pools = new Set();
    this.lazyActors = new Map();
  },

  send: function(packet) {
    if (prefs["logDevToolsProtocolTraffic"]) {
      console.log("<<<<<< Sent to toolbox\n" + JSON.stringify(packet));
    }
    this.transport.send(packet);
  },

  onPacket: task.async(function*(packet) {
    if (prefs["logDevToolsProtocolTraffic"]) {
      console.log(">>>>>> Received from toolbox\n" + JSON.stringify(packet));
    }
    let actor = this.getActor(packet.to);
    if (!actor) {
      this.send({
        from: packet.to || "root",
        error: "noSuchActor",
        message: "No such actor for ID: " + packet.to
      });
    }

    if (packet.type in actor.requestTypes) {
      this.currentPacket = packet;
      actor.requestTypes[packet.type].bind(actor)(packet, this);
      this.currentPacket = undefined;
    } else {
      this.send({
        from: actor.actorID,
        error: "unrecognizedPacketType",
        message: ('Actor "' + actor.actorID +
                  '" does not recognize the packet type "' +
                  packet.type + '"')
      });
    }
  }),

  close() {
    this.transport.close();
    this.transport = null;
  },

  onClosed: function() {
    this.root.destroy();
    connections.delete(this);
  },

  allocID: function(prefix) {
    return this.prefix + (prefix || '') + this.nextID++;
  },

  // XXX: This probably belongs in protocol.js
  manageLazy: function(parent, actorID, factory) {
    this.lazyActors.set(actorID, {
      parent: parent,
      factory: factory
    });
    return actorID;
  },

  getActor: function(actorID) {
    let pool = this.poolFor(actorID)
    if (pool) {
      return pool.get(actorID);
    }

    if (this.lazyActors.has(actorID)) {
      let lazy = this.lazyActors.get(actorID);
      let actor = lazy.factory();
      actor.actorID = actorID;
      lazy.parent.manage(actor);
      this.lazyActors.delete(lazy);
      return actor;
    }

    if (actorID == "root") {
      return this.root;
    }

    return null;
  },

  poolFor: function(actorID) {
    for (let pool of this.pools) {
      if (pool.has(actorID)) {
        return pool;
      }
    }

    return null;
  },

  addActorPool: function(pool) {
    this.pools.add(pool);
  },
  removeActorPool: function(pool) {
    this.pools.delete(pool);
  }
});

//unload(() => {
//  for (let conn of connections) {
//    conn.close();
//  }
//});

exports.connect = function (url="http://localhost:9222") {
  let serverTransport = new LocalDebuggerTransport();
  let clientTransport = new LocalDebuggerTransport(serverTransport);

  serverTransport.other = clientTransport;

  let conn = new Connection("chromium" + connID++, serverTransport, url);
  connections.add(conn);

  conn.root.sayHello();
  serverTransport.ready();

  return clientTransport;
}

// Test if a target is likely to respond by making an early tabs request
exports.ping = function (url="http://localhost:9222") {
  return requestTabs(url);
}
