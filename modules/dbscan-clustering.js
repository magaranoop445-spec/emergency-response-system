export class DBSCANClusterer {
    constructor(epsilon = 0.02, minPoints = 3) {
        this.epsilon = epsilon; // ~2km in lat/lng degrees
        this.minPoints = minPoints;
    }

    // Haversine distance for more accurate geographic distance
    haversineDistance(point1, point2) {
        const R = 6371; // Earth's radius in km
        const lat1 = this.toRadians(point1.lat);
        const lat2 = this.toRadians(point2.lat);
        const deltaLat = this.toRadians(point2.lat - point1.lat);
        const deltaLng = this.toRadians(point2.lng - point1.lng);
        
        const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
                  Math.cos(lat1) * Math.cos(lat2) *
                  Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        
        return R * c;
    }

    toRadians(degrees) {
        return degrees * Math.PI / 180;
    }

    distance(point1, point2) {
        // Convert epsilon from degrees to km for comparison
        // 0.02 degrees ≈ 2.2 km
        return this.haversineDistance(point1, point2);
    }

    regionQuery(points, pointIdx, visited) {
        const neighbors = [];
        const point = points[pointIdx];
        
        for (let i = 0; i < points.length; i++) {
            if (!visited.has(i) && this.distance(point, points[i]) <= this.epsilon * 111) { // Convert degrees to km approx
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
        if (!incidents || incidents.length === 0) {
            return { clusters: [], noise: [], totalClusters: 0 };
        }
        
        const pointsWithCoords = incidents.filter(inc => 
            inc.latitude && inc.longitude && 
            !isNaN(inc.latitude) && !isNaN(inc.longitude)
        );
        
        if (pointsWithCoords.length < this.minPoints) {
            return { clusters: [], noise: pointsWithCoords, totalClusters: 0 };
        }
        
        const points = pointsWithCoords.map(inc => ({ 
            lat: inc.latitude, 
            lng: inc.longitude, 
            incident: inc 
        }));
        
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
                if (!clusters.has(clusterLabel)) {
                    clusters.set(clusterLabel, []);
                }
                clusters.get(clusterLabel).push(pointsWithCoords[i]);
            }
        }
        
        const severityMap = {
            'Medical': 7, 'Fire': 9, 'Police': 6, 
            'Accident': 8, 'NaturalDisaster': 10
        };
        
        const clusterStats = [];
        for (let [id, clusterIncidents] of clusters) {
            const center = this.calculateClusterCenter(clusterIncidents);
            const severity = clusterIncidents.reduce((sum, inc) => 
                sum + (severityMap[inc.emergency_type] || 5), 0) / clusterIncidents.length;
            const types = [...new Set(clusterIncidents.map(inc => inc.emergency_type))];
            
            let priority = 'LOW';
            if (severity >= 8 && clusterIncidents.length >= 5) priority = 'CRITICAL';
            else if (severity >= 7 && clusterIncidents.length >= 3) priority = 'HIGH';
            else if (severity >= 5) priority = 'MEDIUM';
            
            clusterStats.push({
                clusterId: id,
                incidents: clusterIncidents,
                size: clusterIncidents.length,
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
            sumLat += inc.latitude;
            sumLng += inc.longitude;
        });
        return { 
            lat: sumLat / incidents.length, 
            lng: sumLng / incidents.length 
        };
    }

    findHotspots(clusterResult, threshold = 3) {
        return clusterResult.clusters.filter(cluster => 
            cluster.size >= threshold && cluster.severity >= 7
        );
    }

    suggestResponseAllocation(clusterResult) {
        const priorityOrder = { 'CRITICAL': 4, 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1 };
        const sortedClusters = [...clusterResult.clusters].sort((a, b) => 
            priorityOrder[b.priority] - priorityOrder[a.priority]
        );
        
        return sortedClusters.map(cluster => ({
            clusterId: cluster.clusterId,
            priority: cluster.priority,
            suggestedUnits: Math.max(1, Math.ceil(cluster.size / 2)),
            center: cluster.center,
            responseTime: cluster.priority === 'CRITICAL' ? 'IMMEDIATE' : 
                         cluster.priority === 'HIGH' ? 'WITHIN_5_MIN' : 'WITHIN_15_MIN',
            radius: cluster.size * 0.5
        }));
    }
}