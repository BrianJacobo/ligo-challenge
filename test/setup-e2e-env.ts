// Jest runs each e2e spec file as a separate worker process. Giving them all the
// same Mongo database means one file's dropDatabase()/deleteMany() (afterEach /
// afterAll) can wipe data or indexes out from under another file still mid-run —
// this caused real, intermittent failures. JEST_WORKER_ID is unique per worker,
// so it doubles as a per-file database suffix without needing the file name.
const workerId = process.env.JEST_WORKER_ID ?? '0';

process.env.MONGO_URI =
  process.env.MONGO_URI_TEST ?? `mongodb://localhost:27017/ligo-cash-in-e2e-${workerId}`;
process.env.REDIS_URL =
  process.env.REDIS_URL_TEST ?? `redis://localhost:6379/${1 + Number(workerId)}`;
