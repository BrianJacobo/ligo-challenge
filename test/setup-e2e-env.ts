process.env.MONGO_URI =
  process.env.MONGO_URI_TEST ?? 'mongodb://localhost:27017/ligo-cash-in-e2e';
process.env.REDIS_URL = process.env.REDIS_URL_TEST ?? 'redis://localhost:6379/1';
