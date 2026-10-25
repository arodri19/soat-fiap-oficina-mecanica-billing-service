module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/src'],
  // *.steps.js = cenários BDD (jest-cucumber, features em tests/bdd/features)
  testMatch: ['**/?(*.)+(spec|test).[jt]s', '**/*.steps.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/index.js', '!src/config.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],
  // Requisito da Fase 4: cobertura mínima de 80% por serviço (o CI falha abaixo disso)
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 }
  },
  clearMocks: true,
  restoreMocks: true
};
