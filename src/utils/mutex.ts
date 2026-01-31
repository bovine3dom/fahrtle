// early learning centre mutex. why the hell isn't this in the std lib
// pls be good citizen and unlock in try / finally
export class Mutex {
    _queue: Promise<unknown>;
    constructor() {
        this._queue = Promise.resolve();
    }

    lock() {
        let release: (_: void) => void;
        const wait = new Promise(resolve => release = resolve);
        const acquisition = this._queue.then(() => release);
        this._queue = this._queue.then(() => wait);
        return acquisition;
    }
}

