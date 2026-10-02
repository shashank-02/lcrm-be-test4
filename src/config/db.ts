import mongoose from 'mongoose';
import { env } from './env';
import { logger } from './logger';
import { migrateIndexes } from './indexes';

mongoose.set('strictQuery', true);

export async function connectDb(uri = env.MONGODB_URI): Promise<void> {
  await mongoose.connect(uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 10_000 });
  logger.info('MongoDB connected');
  await migrateIndexes();
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
