declare module 'better-sqlite3' {
  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(pragma: string): any;
    transaction(fn: () => void): any;
    close(): void;
  }

  interface Statement {
    run(...params: any[]): RunResult;
    all(...params: any[]): any[];
    get(...params: any[]): any;
  }

  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  const Database: {
    new(filename: string, options?: { verbose?: Function }): Database;
  };

  export default Database;
}
