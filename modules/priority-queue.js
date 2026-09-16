// Priority Queue implementation using Max Heap
export class PriorityQueue {
    constructor() {
        this.heap = [];
    }

    // Get parent index
    getParentIndex(index) {
        return Math.floor((index - 1) / 2);
    }

    // Get left child index
    getLeftChildIndex(index) {
        return 2 * index + 1;
    }

    // Get right child index
    getRightChildIndex(index) {
        return 2 * index + 2;
    }

    // Swap elements
    swap(index1, index2) {
        [this.heap[index1], this.heap[index2]] = [this.heap[index2], this.heap[index1]];
    }

    // Insert incident into priority queue
    enqueue(item) {
        this.heap.push(item);
        this.heapifyUp(this.heap.length - 1);
    }

    // Heapify up (bubble up)
    heapifyUp(index) {
        while (index > 0) {
            const parentIndex = this.getParentIndex(index);
            if (this.heap[parentIndex].priority >= this.heap[index].priority) {
                break;
            }
            this.swap(parentIndex, index);
            index = parentIndex;
        }
    }

    // Extract highest priority incident
    dequeue() {
        if (this.heap.length === 0) return null;
        if (this.heap.length === 1) return this.heap.pop();
        
        const max = this.heap[0];
        this.heap[0] = this.heap.pop();
        this.heapifyDown(0);
        return max;
    }

    // Heapify down (bubble down)
    heapifyDown(index) {
        let largest = index;
        const left = this.getLeftChildIndex(index);
        const right = this.getRightChildIndex(index);
        
        if (left < this.heap.length && this.heap[left].priority > this.heap[largest].priority) {
            largest = left;
        }
        
        if (right < this.heap.length && this.heap[right].priority > this.heap[largest].priority) {
            largest = right;
        }
        
        if (largest !== index) {
            this.swap(index, largest);
            this.heapifyDown(largest);
        }
    }

    // Peek at highest priority without removing
    peek() {
        return this.heap[0] || null;
    }

    // Get size
    size() {
        return this.heap.length;
    }

    // Check if empty
    isEmpty() {
        return this.heap.length === 0;
    }

    // Get all elements sorted
    getAll() {
        return [...this.heap].sort((a, b) => b.priority - a.priority);
    }

    // Update priority of an incident
    updatePriority(id, newPriority) {
        const index = this.heap.findIndex(item => item.id === id);
        if (index !== -1) {
            const oldPriority = this.heap[index].priority;
            this.heap[index].priority = newPriority;
            
            if (newPriority > oldPriority) {
                this.heapifyUp(index);
            } else {
                this.heapifyDown(index);
            }
            return true;
        }
        return false;
    }

    // Remove specific incident
    remove(id) {
        const index = this.heap.findIndex(item => item.id === id);
        if (index !== -1) {
            this.swap(index, this.heap.length - 1);
            this.heap.pop();
            if (index < this.heap.length) {
                this.heapifyDown(index);
            }
            return true;
        }
        return false;
    }

    // Clear queue
    clear() {
        this.heap = [];
    }

    // Print queue (for debugging)
    print() {
        console.log(this.heap.map(item => ({ id: item.id, priority: item.priority })));
    }
}