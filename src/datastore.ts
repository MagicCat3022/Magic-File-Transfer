import fs from 'fs-extra';

class DataStore {
  private filePath: string;
  private _lock: Promise<void>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this._lock = Promise.resolve();
  }

  async _read(): Promise<any> {
    try {
      return await fs.readJson(this.filePath);
    } 
    catch (err: unknown) {
      if (err instanceof Error && (err as any).code === 'ENOENT') {
        return { users: {} };
      }
      throw err;
    }
  }

  async _write(state: any): Promise<void> {
    await fs.outputJson(this.filePath, state, { spaces: 2 });
  }

  async withState(mutator: (state: any) => Promise<any>): Promise<any> {
    this._lock = this._lock.then(async () => {
      const state = await this._read();
      const result = await mutator(state);
      await this._write(state);
      return result;
    });
    return this._lock;
  }

  async readState(selector?: (state: any) => any | Promise<any>) {
    let finalResult;
    this._lock = this._lock.then(async () => {
      const state = await this._read();
      finalResult = selector ? await selector(state) : state;
      return finalResult;
    });
    await this._lock;
    return finalResult;
  }
}

export default DataStore;
