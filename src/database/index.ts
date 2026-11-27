/**
 * Database layer - main exports.
 */

export { createDatabaseClient, closeDatabaseClient, type DatabaseClient, type QueryResult, type Transaction } from './client.ts';
export {
  JobRepository,
  JobDescriptionRepository,
  MatchRepository,
  ResumeRepository,
  CoverLetterRepository,
  ApplicationRepository,
  ApplicationEventRepository,
  BrowserSessionRepository,
  QuestionAnswerRepository,
  CandidateProfileRepository,
} from './repositories.ts';