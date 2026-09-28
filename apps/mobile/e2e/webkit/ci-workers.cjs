const CI_WORKERS = 4;

function workersFor(env = process.env) {
  return env.CI ? CI_WORKERS : undefined;
}

module.exports = { CI_WORKERS, workersFor };
