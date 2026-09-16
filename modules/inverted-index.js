export class InvertedIndex {
    constructor() {
        this.index = new Map();
        this.documents = new Map();
        this.stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having']);
    }

    tokenize(text) {
        if (!text) return [];
        return text.toLowerCase()
            .replace(/[^\w\s\u0900-\u097F]/g, '')
            .split(/\s+/)
            .filter(word => word.length > 2 && !this.stopWords.has(word));
    }

    addDocument(incident) {
        const id = incident.request_id;
        this.documents.set(id, incident);
        
        const searchableText = `${incident.emergency_type} ${incident.description} ${incident.district} ${incident.municipality} ${incident.tole}`;
        const tokens = this.tokenize(searchableText);
        
        tokens.forEach(token => {
            if (!this.index.has(token)) {
                this.index.set(token, new Map());
            }
            const docMap = this.index.get(token);
            docMap.set(id, (docMap.get(id) || 0) + 1);
        });
    }

    removeDocument(id) {
        this.documents.delete(id);
        for (let [term, docMap] of this.index) {
            docMap.delete(id);
            if (docMap.size === 0) {
                this.index.delete(term);
            }
        }
    }

    search(query) {
        const queryTokens = this.tokenize(query);
        if (queryTokens.length === 0) return [];
        
        const candidateDocs = new Map();
        
        queryTokens.forEach(token => {
            if (this.index.has(token)) {
                const docMap = this.index.get(token);
                for (let [docId, tf] of docMap) {
                    if (!candidateDocs.has(docId)) {
                        candidateDocs.set(docId, new Map());
                    }
                    candidateDocs.get(docId).set(token, tf);
                }
            }
        });
        
        const results = [];
        const totalDocs = this.documents.size;
        
        for (let [docId, termFreqMap] of candidateDocs) {
            let score = 0;
            for (let [term, tf] of termFreqMap) {
                const df = this.index.get(term).size;
                const idf = Math.log((totalDocs + 1) / (df + 1)) + 1;
                score += tf * idf;
            }
            
            results.push({
                incident: this.documents.get(docId),
                score: score
            });
        }
        
        return results.sort((a, b) => b.score - a.score);
    }

    rebuildIndex(incidents) {
        this.index.clear();
        this.documents.clear();
        incidents.forEach(incident => this.addDocument(incident));
    }

    getAllDocuments() {
        return Array.from(this.documents.values());
    }
}