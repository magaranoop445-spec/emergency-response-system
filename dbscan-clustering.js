export class DBSCANClusterer {
    constructor(epsilon = 0.02, minPoints = 3) {
        this.epsilon = epsilon; // ~2km in lat/lng degrees
        this.minPoints = minPoints;
    }
    
    distance(point1, point2) {
        const latDiff = point1.lat - point2.lat;
        const lngDiff = point1.lng - point2.lng;
        return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
    }
    
    regionQuery(points, pointIdx, visited) {
        const neighbors = [];
        const point = points[pointIdx];
        
        for (let i = 0; i < points.length; i++) {
            if (!visited.has(i) && this.distance(point, points[i]) <= this.epsilon) {
                neighbors.push(i);
            }
        }
        return neighbors;
    }
    
    expandCluster(points, pointIdx, neighbors, clusterId, labels, visited) {
        labels[pointIdx] = clusterId;
        let i = 0;
        
        while (i < neighbors.length) {
            const currentPointIdx = neighbors[i];
            
            if (!visited.has(currentPointIdx)) {
                visited.add(currentPointIdx);
                const currentNeighbors = this.regionQuery(points, currentPointIdx, visited);
                
                if (currentNeighbors.length >= this.minPoints) {
                    for (const neighbor of currentNeighbors) {
                        if (!neighbors.includes(neighbor)) {
                            neighbors.push(neighbor);
                        }
                    }
                }
            }
            
            if (labels[currentPointIdx] === -1) {
                labels[currentPointIdx] = clusterId;
            }
            i++;
        }
    }
    
    cluster(incidents) {
        if (!incidents || incidents.length === 0) return { clusters: [], noise: [], totalClusters: 0 };
        
        const pointsWithCoords = incidents.filter(inc => inc.lat && inc.lng && !isNaN(inc.lat) && !isNaN(inc.lng));
        if (pointsWithCoords.length < this.minPoints) {
            return { clusters: [], noise: pointsWithCoords, totalClusters: 0 };
        }
        
        const points = pointsWithCoords.map(inc => ({ lat: inc.lat, lng: inc.lng, incident: inc }));
        const n = points.length;
        const labels = new Array(n).fill(-1);
        const visited = new Set();
        let clusterId = 0;
        
        for (let i = 0; i < n; i++) {
            if (!visited.has(i)) {
                visited.add(i);
                const neighbors = this.regionQuery(points, i, visited);
                
                if (neighbors.length < this.minPoints) {
                    labels[i] = -1;
                } else {
                    this.expandCluster(points, i, neighbors, clusterId, labels, visited);
                    clusterId++;
                }
            }
        }
        
        const clusters = new Map();
        for (let i = 0; i < n; i++) {
            const clusterLabel = labels[i];
            if (clusterLabel !== -1) {
                if (!clusters.has(clusterLabel)) clusters.set(clusterLabel, []);
                clusters.get(clusterLabel).push(pointsWithCoords[i]);
            }
        }
        
        const clusterStats = [];
        for (let [id, incidents] of clusters) {
            const center = this.calculateClusterCenter(incidents);
            const severity = this.calculateClusterSeverity(incidents);
            const types = this.getIncidentTypes(incidents);
            
            let priority = 'LOW';
            if (severity >= 8 && incidents.length >= 5) priority = 'CRITICAL';
            else if (severity >= 7 && incidents.length >= 3) priority = 'HIGH';
            else if (severity >= 5) priority = 'MEDIUM';
            
            clusterStats.push({
                clusterId: id,
                incidents: incidents,
                size: incidents.length,
                center: center,
                severity: severity,
                types: types,
                priority: priority
            });
        }
        
        return {
            clusters: clusterStats,
            noise: pointsWithCoords.filter((_, i) => labels[i] === -1),
            totalClusters: clusters.size
        };
    }
    
    calculateClusterCenter(incidents) {
        let sumLat = 0, sumLng = 0;
        incidents.forEach(inc => {
            sumLat += inc.lat;
            sumLng += inc.lng;
        });
        return { lat: sumLat / incidents.length, lng: sumLng / incidents.length };
    }
    
    calculateClusterSeverity(incidents) {
        const severityMap = { 'Medical': 7, 'Fire': 9, 'Police': 6, 'Accident': 8, 'NaturalDisaster': 10 };
        const totalSeverity = incidents.reduce((sum, inc) => sum + (severityMap[inc.type] || 5), 0);
        return totalSeverity / incidents.length;
    }
    
    getIncidentTypes(incidents) {
        const types = new Set();
        incidents.forEach(inc => types.add(inc.type));
        return Array.from(types);
    }
    
    findHotspots(clusterResult, threshold = 3) {
        return clusterResult.clusters.filter(cluster => cluster.size >= threshold && cluster.severity >= 7);
    }
    
    suggestResponseAllocation(clusterResult) {
        const priorityOrder = { 'CRITICAL': 4, 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1 };
        const sortedClusters = [...clusterResult.clusters].sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);
        
        return sortedClusters.map(cluster => ({
            clusterId: cluster.clusterId,
            priority: cluster.priority,
            suggestedUnits: Math.ceil(cluster.size / 2),
            center: cluster.center,
            responseTime: cluster.priority === 'CRITICAL' ? 'IMMEDIATE' : 'WITHIN_15_MIN'
        }));
    }
}