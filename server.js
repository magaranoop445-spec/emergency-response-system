export class InvertedIndex {
    constructor() {
        this.index = new Map();
        this.documents = new Map();
        this.stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were']);
    }

    tokenize(text) {
        if (!text) return [];
        return text.toLowerCase()
            .replace(/[^\w\s]/g, '')
            .split(/\s+/)
            .filter(word => word.length > 2 && !this.stopWords.has(word));
    }

    addDocument(incident) {
        const id = incident.id;
        this.documents.set(id, incident);
        
        const searchableText = `${incident.type} ${incident.locationDesc} ${incident.details || ''}`;
        const tokens = this.tokenize(searchableText);
        
        tokens.forEach(token => {
            if (!this.index.has(token)) {
                this.index.set(token, new Set());
            }
            this.index.get(token).add(id);
        });
    }

    removeDocument(id) {
        this.documents.delete(id);
        for (let [term, docSet] of this.index) {
            docSet.delete(id);
            if (docSet.size === 0) this.index.delete(term);
        }
    }

    search(query) {
        const queryTokens = this.tokenize(query);
        if (queryTokens.length === 0) return [];
        
        const candidateDocs = new Map();
        
        queryTokens.forEach(token => {
            if (this.index.has(token)) {
                const docs = this.index.get(token);
                docs.forEach(docId => {
                    if (!candidateDocs.has(docId)) {
                        candidateDocs.set(docId, new Map());
                    }
                    const termFreq = candidateDocs.get(docId);
                    termFreq.set(token, (termFreq.get(token) || 0) + 1);
                });
            }
        });
        
        const results = [];
        for (let [docId, termFreqMap] of candidateDocs) {
            let score = 0;
            for (let [term, tf] of termFreqMap) {
                const df = this.index.get(term).size;
                const idf = Math.log(this.documents.size / (df + 1));
                score += tf * idf;
            }
            results.push({ incident: this.documents.get(docId), score: score });
        }
        
        return results.sort((a, b) => b.score - a.score);
    }

    rebuildIndex(incidents) {
        this.index.clear();
        this.documents.clear();
        incidents.forEach(incident => {
            if (!incident.resolved) this.addDocument(incident);
        });
    }

    getAllDocuments() {
        return Array.from(this.documents.values());
    }
}