const { Server, Room } = require("@colyseus/core");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { Schema, MapSchema, type } = require("@colyseus/schema");
const express = require("express");
const cors = require("cors");

// ---------- Schemas ----------
class PlayerState extends Schema {
  constructor() {
    super();
    this.x = 150; this.y = 415; this.vx = 0; this.vy = 0;
    this.isJumping = false; this.color = "#ff00ff"; this.side = "left";
    this.name = ""; this.ready = false;
  }
}
type("number")(PlayerState.prototype, "x");
type("number")(PlayerState.prototype, "y");
type("number")(PlayerState.prototype, "vx");
type("number")(PlayerState.prototype, "vy");
type("boolean")(PlayerState.prototype, "isJumping");
type("string")(PlayerState.prototype, "color");
type("string")(PlayerState.prototype, "side");
type("string")(PlayerState.prototype, "name");
type("boolean")(PlayerState.prototype, "ready");

class BallState extends Schema {
  constructor() { super(); this.x = 500; this.y = 250; this.vx = 5; this.vy = -3; }
}
type("number")(BallState.prototype, "x");
type("number")(BallState.prototype, "y");
type("number")(BallState.prototype, "vx");
type("number")(BallState.prototype, "vy");

class KeeperState extends Schema {
  constructor() { super(); this.y = 250; this.vy = 0; }
}
type("number")(KeeperState.prototype, "y");
type("number")(KeeperState.prototype, "vy");

class FootballState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.ball = new BallState();
    this.keeper1 = new KeeperState();
    this.keeper2 = new KeeperState();
    this.p1Score = 0; this.p2Score = 0; this.timeLeft = 120;
    this.gameOver = false; this.winnerMessage = "";
    this.matchState = "waiting";
    this.hostId = ""; this.roomCode = "";
    this.countdown = -1; this.goalFreeze = 0;
    this.password = ""; this.lastWinner = "";
  }
}
type({ map: PlayerState })(FootballState.prototype, "players");
type(BallState)(FootballState.prototype, "ball");
type(KeeperState)(FootballState.prototype, "keeper1");
type(KeeperState)(FootballState.prototype, "keeper2");
type("number")(FootballState.prototype, "p1Score");
type("number")(FootballState.prototype, "p2Score");
type("number")(FootballState.prototype, "timeLeft");
type("boolean")(FootballState.prototype, "gameOver");
type("string")(FootballState.prototype, "winnerMessage");
type("string")(FootballState.prototype, "matchState");
type("string")(FootballState.prototype, "hostId");
type("string")(FootballState.prototype, "roomCode");
type("number")(FootballState.prototype, "countdown");
type("number")(FootballState.prototype, "goalFreeze");
type("string")(FootballState.prototype, "password");
type("string")(FootballState.prototype, "lastWinner");

// ---------- Room ----------
class FootballRoom extends Room {
  constructor() {
    super();
    this.maxClients = 2;
    this.state = new FootballState();
    this.inputs = {};
  }

  onCreate(options) {
    this.state.roomCode = this.roomId;
    this.state.password = options.password || Math.random().toString(36).substr(2, 6);

    this.onMessage("setName", (client, name) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.name = name;
      this.broadcastPlayerInfo();
    });

    this.onMessage("ready", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.ready = !player.ready;
      this.broadcastPlayerInfo();
      if (this.state.players.size === 2 && [...this.state.players.values()].every(p => p.ready)) {
        this.startCountdown();
      }
    });

    this.onMessage("move", (client, input) => {
      if (typeof input === "object") {
        this.inputs[client.sessionId] = {
          left: !!input.left, right: !!input.right,
          up: !!input.up, down: !!input.down,
          shoot: !!input.shoot, turbo: !!input.turbo
        };
      }
    });

    this.onMessage("chat", (client, msg) => {
      const sender = this.state.players.get(client.sessionId)?.name || "Unknown";
      this.broadcast("chat", { sender, text: (msg || "").substring(0, 200) });
    });

    this.onMessage("ping", (client, data) => client.send("pong", data));

    this.setSimulationInterval((dt) => this.gameTick(), 1000 / 30);
  }

  onJoin(client, options) {
    if (options.password !== this.state.password) {
      client.send("error", { message: "Incorrect password" });
      client.leave();
      return;
    }
    if (this.clients.length >= 2) {
      client.send("error", { message: "Room is full" });
      client.leave();
      return;
    }

    const player = new PlayerState();
    const isP1 = this.clients.length === 1;
    if (isP1) this.state.hostId = client.sessionId;
    player.x = isP1 ? 150 : 820;
    player.y = 415;
    player.color = isP1 ? "#ff00ff" : "#00f2ff";
    player.side = isP1 ? "left" : "right";
    this.state.players.set(client.sessionId, player);
    this.broadcastPlayerInfo();
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    this.broadcastPlayerInfo();
    this.broadcast("playerLeft", {});
  }

  broadcastPlayerInfo() {
    const p1 = [...this.state.players.values()].find(p => p.side === "left");
    const p2 = [...this.state.players.values()].find(p => p.side === "right");
    this.broadcast("playerNames", {
      p1: p1?.name || "—", p2: p2?.name || "—",
      p1Ready: p1?.ready || false, p2Ready: p2?.ready || false,
      password: this.state.password
    });
  }

  startCountdown() {
    this.state.matchState = "countdown";
    this.state.countdown = 3;
    this.broadcast("countdown", { value: 3 });
    const interval = setInterval(() => {
      if (this.state.matchState !== "countdown") { clearInterval(interval); return; }
      this.state.countdown--;
      if (this.state.countdown <= 0) {
        clearInterval(interval);
        this.state.matchState = "live";
        this.broadcast("gameStarted");
      } else {
        this.broadcast("countdown", { value: this.state.countdown });
      }
    }, 1000);
  }

  gameTick() {
    if (this.state.matchState !== "live" || this.state.gameOver || this.state.players.size < 2) return;
    if (this.state.goalFreeze > 0) {
      this.state.goalFreeze--;
      if (this.state.goalFreeze === 0) this.broadcast("event", { type: "FREEZE_END" });
      return;
    }

    const FIXED_DT = 1 / 30;
    const ball = this.state.ball;

    this.state.players.forEach((player, sid) => {
      const input = this.inputs[sid] || {};
      const dx = player.x + 15 - ball.x, dy = player.y + 32 - ball.y, hasBall = dx * dx + dy * dy < 2500;

      if (hasBall && (input.shoot || input.turbo)) {
        player.vx = 0;
        const speed = input.turbo ? 45 : 20;
        ball.vx = player.side === "left" ? speed : -speed;
        if (input.up && !input.down) ball.vy = -14;
        else if (input.down) ball.vy = 10;
        else ball.vy = -2;
        this.broadcast("event", { type: "SHOT", data: { turbo: input.turbo, color: player.color } });
      } else {
        if (input.left) player.vx -= 1.3;
        if (input.right) player.vx += 1.3;
        if (input.up && !player.isJumping) { player.vy = -12; player.isJumping = true; }
        if (input.down) player.vy += 1;
      }
    });

    ball.x += ball.vx * FIXED_DT * 60;
    ball.y += ball.vy * FIXED_DT * 60;
    ball.vy += 0.25 * FIXED_DT * 60;
    ball.vx *= 0.995;
    if (ball.y > 480) { ball.y = 480; ball.vy *= -0.7; }
    if (ball.y < 10) { ball.y = 10; ball.vy *= -0.7; }

    [{ x: 5, k: this.state.keeper1 }, { x: 983, k: this.state.keeper2 }].forEach(({ x: kx, k }) => {
      if (ball.x + 10 > kx && ball.x - 10 < kx + 12 && ball.y + 10 > k.y && ball.y - 10 < k.y + 60) {
        if (Math.abs(ball.vx) > 25) this.broadcast("event", { type: "SHOT", data: { turbo: false, color: "#fff" } });
        ball.vx *= -1.1; ball.x = kx < 500 ? 25 : 970;
      }
    });
    this.state.players.forEach(p => {
      if (ball.x + 10 > p.x && ball.x - 10 < p.x + 30 && ball.y + 10 > p.y && ball.y - 10 < p.y + 65) {
        const rvx = ball.vx - p.vx, rvy = ball.vy - p.vy;
        ball.vx = p.vx - rvx * 0.6; ball.vy = p.vy - rvy * 0.6;
        ball.x = ball.x < p.x + 15 ? p.x - 11 : p.x + 31;
      }
    });

    if (ball.x < 0 || ball.x > 1000) {
      if (ball.y > 150 && ball.y < 350) {
        if (ball.x < 0) this.state.p2Score++; else this.state.p1Score++;
        this.broadcast("event", { type: "GOAL", data: { scorer: ball.x < 0 ? "p2" : "p1", color: ball.x < 0 ? "#00f2ff" : "#ff00ff" } });
        this.state.goalFreeze = 60;
        ball.x = 500; ball.y = 250; ball.vx = (Math.random() > 0.5 ? 5 : -5); ball.vy = -3;
        if (this.state.p1Score >= 10 || this.state.p2Score >= 10) {
          this.state.gameOver = true; this.state.matchState = "end";
          this.state.winnerMessage = this.state.p1Score >= 10 ? "Player 1 Wins!" : "Player 2 Wins!";
          this.state.lastWinner = this.state.p1Score >= 10 ? "p1" : "p2";
        }
      } else { ball.vx *= -1; ball.x = ball.x < 0 ? 5 : 995; }
    }

    const targetY = ball.y - 30;
    [this.state.keeper1, this.state.keeper2].forEach((k, i) => {
      k.vy += (targetY - k.y) * (i === 0 ? 0.12 : 0.1);
      k.vy *= 0.7; k.y += k.vy * FIXED_DT * 60;
      k.y = Math.min(295, Math.max(155, k.y));
    });

    this.state.players.forEach(p => {
      p.vy += 0.7; p.x += p.vx * FIXED_DT * 60; p.y += p.vy * FIXED_DT * 60; p.vx *= 0.85;
      if (p.y > 415) { p.y = 415; p.vy = 0; p.isJumping = false; }
      p.x = Math.min(930, Math.max(40, p.x));
    });

    if (this.state.timeLeft > 0) {
      this.state.timeLeft -= FIXED_DT;
      if (this.state.timeLeft <= 0) {
        this.state.gameOver = true; this.state.matchState = "end";
        this.state.winnerMessage = this.state.p1Score > this.state.p2Score ? "Player 1 Wins!" : (this.state.p2Score > this.state.p1Score ? "Player 2 Wins!" : "Draw!");
      }
    }
  }
}

// ---------- Express server ----------
const app = express();
app.set("trust proxy", 1);
app.use(cors());

app.get("/", (_, res) => res.send("Football server is running ✅"));
app.get("/health", (_, res) => res.send("OK"));

const port = process.env.PORT || 2567;
const httpServer = app.listen(port, () => {
  console.log(`⚡ HTTP server listening on port ${port}`);
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer })
});
gameServer.define("football", FootballRoom);
console.log(`⚡ Colyseus WebSocket ready on port ${port}`);
