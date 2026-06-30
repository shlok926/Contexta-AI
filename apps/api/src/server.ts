import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import runsRouter from './routes/runs.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Routes
app.use('/v1/health', healthRouter);
app.use('/v1/auth', authRouter);
app.use('/v1/workspaces/:workspace_id/threads/:thread_id/runs', runsRouter);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
