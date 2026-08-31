module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // .claude/ is agent scratch space (worktree checkouts of other commits). Its
  // tests/ dirs are not this project's suite and pin long-deleted modules.
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/'],
  // These suites drive the real Express app against the real SQLite file at
  // data/products.db — deliberately, since mocking the DB would stop proving that
  // grants and caps actually persist. But they share one `users` row for
  // usr_alice, and several flip delegation_mode to 'partial' to prove the agent
  // is refused. Run in parallel, one worker's 'partial' is visible to another
  // worker mid-checkout, which 402s an autonomous purchase that should have
  // succeeded. That surfaced as roughly a 1-in-5 red run on a money path.
  //
  // The concurrency decision belongs here rather than in a try/finally at each of
  // the seven call sites: restoring the row narrows the window but cannot close
  // it, and the next test to touch shared state would reopen it. Serial costs
  // about a second on a 1.2s suite.
  maxWorkers: 1,
  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: 'coverage',
  verbose: true,
};
