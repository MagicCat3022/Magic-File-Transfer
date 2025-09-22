const fs = require('fs-extra');

class DataStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._lock = Promise.resolve();
  }

  async _read() {
    try {
      return await fs.readJson(this.filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { users: {} };
      }
      throw err;
    }
  }

  async _write(state) {
    await fs.outputJson(this.filePath, state, { spaces: 2 });
  }

  async withState(mutator) {
    this._lock = this._lock.then(async () => {
      const state = await this._read();
      const result = await mutator(state);
      await this._write(state);
      return result;
    });
    return this._lock;
  }

  async readState(selector) {
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

module.exports = DataStore;
