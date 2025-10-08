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
if (!MONGODB_URI) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

type Task = {
  _id?: string;
  id: string; // UUID for external references
  title: string;
  column: "todo" | "inprogress" | "done" | "unsure";
  createdAt: number;
};

(async () => {
  const mongo = new MongoClient(MONGODB_URI);
  await mongo.connect();
  const db = mongo.db("taskboard");
  const tasksCol = db.collection("tasks");

  const app = express();
  app.use(cors());
  app.use(express.json());

  // ================= REST API =================
  app.get("/tasks", async (req, res) => {
    const docs = await tasksCol.find().sort({ createdAt: 1 }).toArray();
    res.json(docs);
  });

  app.post("/tasks", async (req, res) => {
    const { title, column } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });

    const task: Task = {
      id: uuidv4(),
      title,
      column: column || "todo",
      createdAt: Date.now(),
    };

    const r = await tasksCol.insertOne(task as any);
    const inserted = await tasksCol.findOne({ _id: r.insertedId });

    broadcast({ type: "task_created", task: inserted });
    res.json(inserted);
  });

  app.put("/tasks/:id", async (req, res) => {
    const id = req.params.id; // UUID string
    const body = req.body;

    // update first
    await tasksCol.updateOne({ id }, { $set: body });

    // fetch updated document directly
    const updated = await tasksCol.findOne({ id });
    if (!updated) return res.status(404).json({ error: "not found" });

    broadcast({ type: "task_updated", task: updated });
    res.json(updated);
  });

app.delete("/tasks/:id", async (req, res) => {
  const id = req.params.id;
  const r = await tasksCol.deleteOne({ id }); // delete by UUID

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
      const tasks = await tasksCol.find().sort({ createdAt: 1 }).toArray();
      ws.send(JSON.stringify({ type: "init", tasks }));
    })();

    ws.on("message", async (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "reorder") {
          const updates = msg.tasks as Task[];
          for (const t of updates) {
            await tasksCol.updateOne(
              { id: t.id }, // use UUID id
              { $set: { column: t.column, createdAt: t.createdAt } }
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
