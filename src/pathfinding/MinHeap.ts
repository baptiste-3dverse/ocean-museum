/** Binary min-heap keyed by a number (priority queue for A* / Dijkstra). */
export class MinHeap<T> {
    #items: Array<{ key: number; value: T }> = [];

    get size(): number {
        return this.#items.length;
    }

    push(key: number, value: T): void {
        const a = this.#items;
        a.push({ key, value });
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].key <= a[i].key) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }

    pop(): { key: number; value: T } | undefined {
        const a = this.#items;
        if (!a.length) return undefined;
        const top = a[0];
        const last = a.pop()!;
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;
                if (l < a.length && a[l].key < a[m].key) m = l;
                if (r < a.length && a[r].key < a[m].key) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]];
                i = m;
            }
        }
        return top;
    }
}
