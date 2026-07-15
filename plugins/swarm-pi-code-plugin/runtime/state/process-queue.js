/** Serialize same-key work within one process while allowing different keys to proceed. */
export class ProcessLocalQueue {
    tails = new Map();
    get size() {
        return this.tails.size;
    }
    async run(key, operation) {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release;
        const turn = new Promise((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => turn);
        this.tails.set(key, tail);
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
            if (this.tails.get(key) === tail)
                this.tails.delete(key);
        }
    }
}
