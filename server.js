const { Server, Room } = require("@colyseus/core");   // <-- Room added here!
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { Schema, MapSchema, type } = require("@colyseus/schema");
const express = require("express");

// ---------- State Definitions ----------
class PlayerState extends Schema {
  constructor() {
    super();
    this.x = 150;
    this.y = 415;
    this.vx = 0;
    this.vy = 0;
    this.isJumping = false;
    this.color = "#ff00ff";
    this.side = "left";
  }
}
type("number")(PlayerState.prototype, "x");
type("number")(PlayerState.prototype, "y");
type("number")(PlayerState.prototype, "vx");
type("number")(PlayerState.prototype, "vy");
type("boolean")(PlayerState.prototype, "isJumping");
type("string")(PlayerState.prototype, "color");
type("string")(PlayerState.prototype, "side");

class BallState extends Schema {
  constructor() {
    super();
    this.x = 500;
    this.y = 250;
    this.vx = 5;
    this.vy = -3;
  }
}
type("number")(BallState.prototype, "x");
type("number")(BallState.prototype, "y");
type("number")(BallState.prototype, "vx");
type("number")(BallState.prototype, "vy");

class KeeperState extends Schema {
  constructor() {
    super();
    this.y = 250;
    this.vy = 0;
  }
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
    this.p1Score = 0;
    this.p2Score = 0;
    this.timeLeft = 120;
    this.gameOver = false;
    this.winnerMessage = "";
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

// ---------- Room Logic ----------
class FootballRoom extends Room {
  constructor() {
    super();
    this.maxClients = 2;
    this.state = new FootballState();
    this.inputs = {};
    this.readyPlayers = new Set();
    this.hostId = "";
    this.targetGoals = 10;
  }

  onCreate(options) {
    this.setSimulationInterval(() => this.gameTick());

    this.onMessage("ready", (client) => {
      if (this.readyPlayers.has(client.sessionId)) {
        this.readyPlayers.delete(client.sessionId);
      } else {
        this.readyPlayers.add(client.sessionId);
      }
      this.broadcast("readyUpdate", {
        p1Ready: this.readyPlayers.has(this.hostId),
        p2Ready: [...this.readyPlayers].some(id => id !== this.hostId)
      });
      if (this.readyPlayers.size === 2) {
        this.broadcast("startGame");
        this.broadcast("event", { type: "MUSIC_NEXT" });
      }
    });

    this.onMessage("move", (client, input) => {
      this.inputs[client.sessionId] = input;
    });

    this.onMessage("chat", (client, msg) => {
      this.broadcast("chat", {
        sender: client.sessionId === this.hostId ? "P1" : "P2",
        text: msg
      });
    });
  }

  onJoin(client) {
    if (this.clients.length === 1) this.hostId = client.sessionId;
    const player = new PlayerState();
    const isP1 = this.clients.length === 1;
    player.x = isP1 ? 150 : 820;
    player.y = 415;
    player.color = isP1 ? "#ff00ff" : "#00f2ff";
    player.side = isP1 ? "left" : "right";
    this.state.players.set(client.sessionId, player);
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    this.readyPlayers.delete(client.sessionId);
    this.broadcast("playerLeft", { sessionId: client.sessionId });
  }

  gameTick() {
    if (this.state.gameOver || this.readyPlayers.size < 2) return;
    const FIXED_DT = 1 / 60;

    // Apply inputs
    this.state.players.forEach((player, sessionId) => {
      const input = this.inputs[sessionId] || {};
      const ball = this.state.ball;
      const dx = player.x + 15 - ball.x;
      const dy = player.y + 32 - ball.y;
      const hasBall = dx * dx + dy * dy < 2500;

      if (hasBall && (input.shoot || input.turbo)) {
        player.vx = 0;
        const baseSpeed = input.turbo ? 45 : 20;
        ball.vx = player.side === "left" ? baseSpeed : -baseSpeed;
        if (input.up && !input.down) ball.vy = -14;
        else if (input.down) ball.vy = 10;
        else ball.vy = -2;
        this.broadcast("event", { type: "SHOT", data: { turbo: input.turbo, color: player.color } });
      } else {
        if (input.left) player.vx -= 1.1;
        if (input.right) player.vx += 1.1;
        if (input.up && !player.isJumping) {
          player.vy = -14;
          player.isJumping = true;
        }
        if (input.down) player.vy += 1;
      }
    });

    // Ball physics
    const ball = this.state.ball;
    ball.x += ball.vx * FIXED_DT * 60;
    ball.y += ball.vy * FIXED_DT * 60;
    ball.vy += 0.25 * FIXED_DT * 60;
    ball.vx *= 0.995;

    if (ball.y > 480) { ball.y = 480; ball.vy *= -0.7; }
    if (ball.y < 10) { ball.y = 10; ball.vy *= -0.7; }

    // Keeper collisions
    const keepers = [{ x: 5, k: this.state.keeper1 }, { x: 983, k: this.state.keeper2 }];
    keepers.forEach(({ x: kx, k }) => {
      if (ball.x + 10 > kx && ball.x - 10 < kx + 12 && ball.y + 10 > k.y && ball.y - 10 < k.y + 60) {
        if (Math.abs(ball.vx) > 25) this.broadcast("event", { type: "SHOT", data: { turbo: false, color: "#fff" } });
        ball.vx *= -1.1;
        ball.x = kx < 500 ? 25 : 970;
      }
    });

    // Player collisions
    this.state.players.forEach(player => {
      if (ball.x + 10 > player.x && ball.x - 10 < player.x + 30 && ball.y + 10 > player.y && ball.y - 10 < player.y + 65) {
        const relVx = ball.vx - player.vx;
        const relVy = ball.vy - player.vy;
        ball.vx = player.vx - relVx * 0.6;
        ball.vy = player.vy - relVy * 0.6;
        ball.x = ball.x < player.x + 15 ? player.x - 11 : player.x + 31;
      }
    });

    // Goal detection
    if (ball.x < 0 || ball.x > 1000) {
      if (ball.y > 150 && ball.y < 350) {
        if (ball.x < 0) this.state.p2Score++; else this.state.p1Score++;
        this.broadcast("event", {
          type: "GOAL",
          data: { scorer: ball.x < 0 ? "p2" : "p1", color: ball.x < 0 ? "#00f2ff" : "#ff00ff" }
        });
        ball.x = 500; ball.y = 250;
        ball.vx = (Math.random() > 0.5 ? 5 : -5);
        ball.vy = -3;
        if (this.state.p1Score >= this.targetGoals || this.state.p2Score >= this.targetGoals) {
          this.state.gameOver = true;
          this.state.winnerMessage = this.state.p1Score >= this.targetGoals ? "Player 1 Wins!" : "Player 2 Wins!";
        }
      } else {
        ball.vx *= -1;
        ball.x = ball.x < 0 ? 5 : 995;
      }
    }

    // Keeper AI
    const targetY = ball.y - 30;
    [this.state.keeper1, this.state.keeper2].forEach((k, i) => {
      k.vy += (targetY - k.y) * (i === 0 ? 0.12 : 0.1);
      k.vy *= 0.7;
      k.y += k.vy * FIXED_DT * 60;
      k.y = Math.min(295, Math.max(155, k.y));
    });

    // Player updates
    this.state.players.forEach(player => {
      player.vy += 0.7;
      player.x += player.vx * FIXED_DT * 60;
      player.y += player.vy * FIXED_DT * 60;
      player.vx *= 0.85;
      if (player.y > 415) { player.y = 415; player.vy = 0; player.isJumping = false; }
      player.x = Math.min(930, Math.max(40, player.x));
    });

    // Timer
    if (this.state.timeLeft > 0) {
      this.state.timeLeft -= FIXED_DT;
      if (this.state.timeLeft <= 0) {
        this.state.gameOver = true;
        this.state.winnerMessage = this.state.p1Score > this.state.p2Score ? "Player 1 Wins!" : (this.state.p2Score > this.state.p1Score ? "Player 2 Wins!" : "Draw!");
      }
    }
  }
}

// Start server
const app = express();
const port = process.env.PORT || 2567;

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: app.listen(port)
  })
});

gameServer.define("football", FootballRoom);
console.log(`⚔️  Football server running on port ${port}`);