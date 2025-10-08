import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import http from "http";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const MONGODB_URI = process.env.MONGODB_URI!;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "supersecret";

if (!MONGODB_URI) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

type Task = {
  _id?: string;
  id: string;
  title: string;
  description?: string;
  column: "todo" | "inprogress" | "done" | "unsure";
  createdAt: number;
  order: number; // <-- new field
};

(async () => {
  const mongo = new MongoClient(MONGODB_URI);
  await mongo.connect();
  const db = mongo.db("taskboard");
  const tasksCol = db.collection("tasks");

  const app = express();
  app.use(cors());
  app.use(express.json());

  // ================= Simple auth middleware =================
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${AUTH_TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });

  // ================= REST API =================
  app.get("/tasks", async (req, res) => {
    const docs = await tasksCol
      .find()
      .sort({ column: 1, order: 1 }) // <-- sort by column then order
      .toArray();
    const tasksWithIds = docs.map((d) => ({
      _id: d._id.toString(),
      id: d.id,
      title: d.title,
      description: d.description || "",
      column: d.column,
      createdAt: d.createdAt,
      order: d.order ?? 0,
    }));
    res.json(tasksWithIds);
  });

  app.post("/tasks", async (req, res) => {
    const { title, column, description } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });

    // Determine max order in this column
    const maxOrderDoc = await tasksCol
      .find({ column: column || "todo" })
      .sort({ order: -1 })
      .limit(1)
      .toArray();
    const nextOrder = maxOrderDoc[0]?.order != null ? maxOrderDoc[0].order + 1 : 0;

    const task: Task = {
      id: uuidv4(),
      title,
      description: description || "",
      column: column || "todo",
      createdAt: Date.now(),
      order: nextOrder,
    };

    await tasksCol.insertOne(task as any);

    broadcast({ type: "task_created", task });

    res.json(task);
  });

  app.put("/tasks/:id", async (req, res) => {
    const id = req.params.id;
    const body = req.body;

    await tasksCol.updateOne({ id }, { $set: body });
    const updated = await tasksCol.findOne({ id });
    if (!updated) return res.status(404).json({ error: "not found" });

    broadcast({ type: "task_updated", task: updated });
    res.json(updated);
  });

  app.delete("/tasks/:id", async (req, res) => {
    const id = req.params.id;
    const r = await tasksCol.deleteOne({ id });
    if (r.deletedCount === 0) return res.status(404).json({ error: "not found" });

    broadcast({ type: "task_deleted", id });
    res.json({ success: true });
  });

  // ================= HTTP + WebSocket server =================
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  function broadcast(payload: any) {
    const msg = JSON.stringify(payload);
    wss.clients.forEach((client: any) => {
      if (client.readyState === 1) client.send(msg);
    });
  }

  wss.on("connection", (ws) => {
    // Send current tasks on connect
    (async () => {
      const tasks = await tasksCol.find().sort({ column: 1, order: 1 }).toArray();
      ws.send(JSON.stringify({ type: "init", tasks }));
    })();

    ws.on("message", async (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "reorder") {
          const updates = msg.tasks as Task[];

          // Update all tasks with new column + order
          for (const t of updates) {
            await tasksCol.updateOne(
              { id: t.id },
              { $set: { column: t.column, order: t.order } }
            );
          }

          broadcast({ type: "tasks_reorder", tasks: updates });
        }
      } catch (err) {
        console.error("ws message error", err);
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`Backend listening on ${PORT}`);
  });
})();
