"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const assert_1 = __importDefault(require("assert"));
const legacy = require('zigbee-herdsman-converters/lib/legacy');
const fz = { ...require('zigbee-herdsman-converters/converters/fromZigbee'), legacy: require('zigbee-herdsman-converters/lib/legacy').fromZigbee };
const tz = { ...require('zigbee-herdsman-converters/converters/toZigbee'), legacy: require('zigbee-herdsman-converters/lib/legacy').toZigbee };
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const ota = require('zigbee-herdsman-converters/lib/ota');
const utils = require('zigbee-herdsman-converters/lib/utils');
const globalStore = require('zigbee-herdsman-converters/lib/store');
const tuya = require('zigbee-herdsman-converters/lib/tuya');
const e = exposes.presets;
const ea = exposes.access;
const customHelpers = {
    getDatapointConverter: (meta, dpId) => {
        // @ts-ignore
        const converter = meta.tuyaDatapoints?.find((d) => d[0] === dpId);
        if (converter === undefined) {
            throw new Error(`No converter for dpId: ${dpId}`);
        }
        return converter[2];
    },

    dataTypes: {
        raw: 0, // [ bytes ]
        bool: 1, // [0/1]
        value: 2, // [ 4 byte value ]
        string: 3, // [ N byte string ]
        enum: 4, // [ 0-255 ]
        bitmap: 5, // [ 1,2,4 bytes ] as bits
    },
    convertMultiByteNumberPayloadToSingleDecimalNumber: (chunks) => {
        // Destructuring "chunks" is needed because it's a Buffer
        // and we need a simple array.
        let value = 0;
        for (let i = 0; i < chunks.length; i++) {
            value = value << 8;
            value += chunks[i];
        }
        return value;
    },
    getDataValue: (dpValue) => {
        let dataString = '';
        switch (dpValue.datatype) {
            case customHelpers.dataTypes.raw:
                return dpValue.data;
            case customHelpers.dataTypes.bool:
                return dpValue.data[0] === 1;
            case customHelpers.dataTypes.value:
                return customHelpers.convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
            case customHelpers.dataTypes.string:
                // Don't use .map here, doesn't work: https://github.com/Koenkk/zigbee-herdsman-converters/pull/1799/files#r530377091
                for (let i = 0; i < dpValue.data.length; ++i) {
                    dataString += String.fromCharCode(dpValue.data[i]);
                }
                return dataString;
            case customHelpers.dataTypes.enum:
                return dpValue.data[0];
            case customHelpers.dataTypes.bitmap:
                return customHelpers.convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
        }
    }
};
const customExpose = {};
const customValueConverter = {
    scheduleWithDay: (dayNum) => {
        return {
            from: (v) => customValueConverter.schedule().from(v),
            to: (v) => {
                const payload = customValueConverter.schedule().to(v);
                payload.unshift(dayNum);
                return payload;
            },
        };
    },
    schedule: () => {
        let Mode;
        (function (Mode) {
            Mode["Manual"] = "manual";
            Mode["Eco"] = "eco";
            Mode["Comfort"] = "comfort";
            Mode["Sleep"] = "sleep";
        })(Mode || (Mode = {}));
        const modes = [
            { code: 0x10, offset: 0xc0, mode: Mode.Sleep, temperature: 0 },
            { code: 0x20, offset: 0xc0, mode: Mode.Eco, temperature: 150 },
            { code: 0x30, offset: 0xc0, mode: Mode.Comfort, temperature: 200 },
            { code: 0x40, offset: 0xa0, mode: Mode.Manual, temperature: undefined },
        ];
        const modeByCode = new Map(modes.map((m) => [m.code, m]));
        const modeByMode = new Map(modes.map((m) => [m.mode.valueOf(), m]));
        return {
            from: (v) => {
                const daySchedule = [];
                for (let index = 1; index < 24; index = index + 4) {
                    const firstByte = parseInt(v[index + 0], 10);
                    const secondByte = parseInt(v[index + 1], 10);
                    const thirdByte = parseInt(v[index + 2], 10);
                    const temperature = (parseFloat(v[index + 3]) / 10.0).toFixed(1);
                    const mode = modeByCode.get(thirdByte);
                    if (mode === undefined) {
                        throw new Error(`Invalid mode byte: "${thirdByte}"`);
                    }
                    const minutesSinceMidnight = ((firstByte - mode.offset) << 8) | secondByte;
                    const hour = Math.floor(minutesSinceMidnight / 60);
                    const minutes = minutesSinceMidnight % 60;
                    const schedule = String(hour).padStart(2, '0') +
                        ':' +
                        String(minutes).padStart(2, '0') +
                        '/' +
                        (mode.mode === Mode.Manual ? temperature : mode.mode);
                    daySchedule.push(schedule);
                }
                return Array.from(new Set(daySchedule)).join(' ');
            },
            to: (v) => {
                const parseTransition = (transition) => {
                    const parts = transition.split('/');
                    if (parts.length !== 2) {
                        throw new Error(`Invalid schedule: wrong transition format "${transition}"`);
                    }
                    const [timePart, setting] = parts;
                    const timeParts = timePart.split(':');
                    if (timeParts.length !== 2) {
                        throw new Error(`Invalid time format in: "${transition}"`);
                    }
                    const hour = parseInt(timeParts[0], 10);
                    const min = parseInt(timeParts[1], 10);
                    if (hour < 0 || hour > 23 || min < 0 || min > 59) {
                        throw new Error(`Invalid hour or minute in: "${transition}"`);
                    }
                    return { minutesSinceMidnight: hour * 60 + min, setting };
                };
                const inputTransitions = v.split(/\s+/).filter(Boolean);
                if (inputTransitions.length < 1 || inputTransitions.length > 6) {
                    throw new Error(`Invalid schedule: there should be between 1 and 6 transitions, got "${inputTransitions.length}"`);
                }
                const transitions = [];
                const seenTimes = new Set();
                for (const inputTransition of inputTransitions) {
                    const transition = parseTransition(inputTransition);
                    if (!seenTimes.has(transition.minutesSinceMidnight)) {
                        seenTimes.add(transition.minutesSinceMidnight);
                        transitions.push(transition);
                    }
                }
                if (transitions.length === 0) {
                    throw new Error('No valid transitions found.');
                }
                transitions.sort((a, b) => a.minutesSinceMidnight - b.minutesSinceMidnight);
                while (transitions.length < 6) {
                    transitions.push(transitions[transitions.length - 1]);
                }
                const payload = [];
                for (const { minutesSinceMidnight, setting } of transitions) {
                    let temperature = parseFloat(setting);
                    let mode = modeByMode.get(setting);
                    if (mode !== undefined) {
                        temperature = mode.temperature;
                    }
                    else if (!isNaN(temperature)) {
                        mode = modeByMode.get(Mode.Manual);
                        temperature = Math.floor(temperature * 10);
                        if (temperature < 50 || temperature > 350) {
                            throw new Error(`Invalid temperature: "${temperature}"`);
                        }
                    }
                    else {
                        throw new Error(`Invalid setting: "${setting}"`);
                    }
                    payload.push(((minutesSinceMidnight & 0xf00) >> 8) + mode.offset, minutesSinceMidnight & 0xff, mode.code, temperature);
                }
                return payload;
            },
        };
    },
};

// *** START OF ADDED HELPER FUNCTION ***
// Helper function to get the currently scheduled temperature based on day/time
// Returns null if schedule cannot be determined or if the setting is not a temperature
const getActiveScheduleTemperature = (meta) => {
    try {
        const now = new Date();
        const dayOfWeek = now.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
        const tuyaDay = dayOfWeek === 0 ? 7 : dayOfWeek; // Map Sunday to 7 for Tuya

        const dayToDpName = {
            1: 'schedule_monday', 2: 'schedule_tuesday', 3: 'schedule_wednesday',
            4: 'schedule_thursday', 5: 'schedule_friday', 6: 'schedule_saturday', 7: 'schedule_sunday',
        };
        const scheduleDpName = dayToDpName[tuyaDay];
        const scheduleString = meta.state[scheduleDpName];

        if (!scheduleString || typeof scheduleString !== 'string') return null;

        // Minimal parsing logic adapted from customValueConverter.schedule().to structure
        const parseTransition = (transition) => {
             const parts = transition.split('/');
             if (parts.length !== 2) return null;
             const [timePart, setting] = parts;
             const timeParts = timePart.split(':');
             if (timeParts.length !== 2) return null;
             const hour = parseInt(timeParts[0], 10);
             const min = parseInt(timeParts[1], 10);
             if (isNaN(hour) || isNaN(min) || hour < 0 || hour > 23 || min < 0 || min > 59) return null;
             return { minutesSinceMidnight: hour * 60 + min, setting };
        };

        const transitions = scheduleString.split(/\s+/)
                                        .map(parseTransition)
                                        .filter(t => t !== null)
                                        .sort((a, b) => a.minutesSinceMidnight - b.minutesSinceMidnight);

        if (transitions.length === 0) return null;

        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        let activeTransition = transitions[transitions.length - 1]; // Default to last if no earlier one matches
        for (let i = transitions.length - 1; i >= 0; i--) {
            if (currentMinutes >= transitions[i].minutesSinceMidnight) {
                activeTransition = transitions[i];
                break;
            }
        }

        const setting = activeTransition.setting;
        // Map schedule setting strings to configured temperatures
        if (setting === 'comfort') return meta.state.comfort_temperature;
        if (setting === 'eco') return meta.state.eco_temperature;
        if (setting === 'sleep') return meta.state.sleep_temperature; // Assuming sleep setting implies sleep_temperature

        const temp = parseFloat(setting);
        return !isNaN(temp) ? temp : null; // Return parsed temp or null if setting wasn't a known mode or number
    } catch (error) {
        console.error(`TRV602Z(fz): Error getting schedule temperature: ${error.message}`);
        return null; // Return null on any error during parsing/lookup
    }
};
// *** END OF ADDED HELPER FUNCTION ***


const definition = {
    fingerprint: tuya.fingerprint('TS0601', ['_TZE204_ltwbm23f']),
    model: 'TRV602Z',
    vendor: 'Tuya',
    description: 'Thermostatic radiator valve (andreypuhovsky/beta5 - with Refactored Modes)',
    configure: tuya.configureMagicPacket,
    onEvent: tuya.onEvent(),
    isModernExtend: true,
    fromZigbee: [
        {
            cluster: 'genBasic',
            type: ['attributeReport', 'readResponse'],
            // @ts-ignore
            convert: (model, msg, publish, options, meta) => {
                return {
                    boost_duration: meta.state.boost_duration ?? 15,
                    away_duration: meta.state.away_duration ?? 7,
                    boost_till: meta.state.boost_till ?? 'off',
                    away_till: meta.state.away_till ?? 'off',
                    setpoint_after_boost: meta.state.setpoint_after_boost ?? undefined,
                };
            },
        },
        tuya.fz.datapoints,
        {
            cluster: 'manuSpecificTuya',
            type: ['commandDataResponse', 'commandDataReport', 'commandActiveStatusReport', 'commandActiveStatusReportAlt'],
            // @ts-ignore
            // *** START OF REFACTORED convert FUNCTION ***
            convert: (model, msg, publish, options, meta) => {
                // *** ADDED: New Enums for MQTT state calculation ***
                let MqttSystemMode;
                (function (MqttSystemMode) {
                    MqttSystemMode["Off"] = "off";
                    MqttSystemMode["Heat"] = "heat";
                    MqttSystemMode["Auto"] = "auto";
                })(MqttSystemMode || (MqttSystemMode = {}));
                let MqttPreset;
                (function (MqttPreset) {
                    MqttPreset["Manual"] = "manual";
					MqttPreset["Sleep"] = "sleep";
                    MqttPreset["Comfort"] = "comfort";
                    MqttPreset["Eco"] = "eco";
                    MqttPreset["Away"] = "away";
                    MqttPreset["Boost"] = "boost";
                    MqttPreset["Schedule"] = "schedule";
                    MqttPreset["Complex"] = "complex";
                    MqttPreset["None"] = null;
                })(MqttPreset || (MqttPreset = {}));
                // --- End Added Enums ---
                let DeviceMode;
                (function (DeviceMode) {
                    DeviceMode["Off"] = "off";
                    DeviceMode["Sleep"] = "sleep";
                    DeviceMode["Eco"] = "eco";
                    DeviceMode["Comfort"] = "comfort";
                    DeviceMode["Auto"] = "auto";
                    DeviceMode["On"] = "on";
                })(DeviceMode || (DeviceMode = {}));
                const deviceModeDP = 2;
                const currentHeatingSetpointDP = 4;
                const awayDurationSetDP = 117;
                const boostDurationSetDP = 118;
                // Update on DPs
                const maxTemperatureDP = 9;
                const minTemperatureDP = 10;
                const comfortTemperatureDP = 119;
                const ecoTemperatureDP = 120;
                const sleepTemperatureDP = 121;

                const reactOnDpIds = [
                    // Decision DPs
                    deviceModeDP,
                    currentHeatingSetpointDP,
                    awayDurationSetDP,
                    boostDurationSetDP,
                    // Update DPs
                    maxTemperatureDP,
                    minTemperatureDP,
                    comfortTemperatureDP,
                    ecoTemperatureDP,
                    sleepTemperatureDP,
                ];
				console.info('1====================================');
                const receivedData = {};
                for (const dpValue of msg.data.dpValues) {
                     if (dpValue.dp === undefined) continue;
                     try {
                         // Use the specific converter for the DP if available
                         const converter = model.meta.tuyaDatapoints?.find(d => d[0] === dpValue.dp);
                         if (converter && converter[2] && typeof converter[2].from === 'function') {
                            receivedData[dpValue.dp] = converter[2].from(customHelpers.getDataValue(dpValue));
                         } else {
                            // Fallback to generic getDataValue if no specific 'from' converter exists
                            receivedData[dpValue.dp] = customHelpers.getDataValue(dpValue);
                         }
                     } catch (error) {
                         console.error(`TRV602Z(fz): Error getting value for DP ${dpValue.dp}: ${error.message}`);
                     }
                }
				console.info('2====================================');

                // *** Relevancy Check ***
                const relevantUpdate = reactOnDpIds.some((dpId) => dpId in receivedData);
				if (!relevantUpdate && Object.keys(receivedData).length > 0) {
					return {};
				}
				console.info('receivedData[deviceModeDP]             =' + receivedData[deviceModeDP]);
				console.info('receivedData[currentHeatingSetpointDP] =' + receivedData[currentHeatingSetpointDP])
				console.info('receivedData[awayDurationSetDP]        =' + receivedData[awayDurationSetDP])
				console.info('receivedData[boostDurationSetDP]       =' + receivedData[boostDurationSetDP])

                // *** Variable Retrieval Section (using received data or previous state) ***
                const receivedTuyaDeviceMode = receivedData[deviceModeDP];
                const currentTuyaDeviceMode = receivedTuyaDeviceMode !== undefined ? receivedTuyaDeviceMode : meta.state.device_mode;

                const receivedHeatingSetpoint = receivedData[currentHeatingSetpointDP];
                const currentHeatingSetpoint = receivedHeatingSetpoint !== undefined ? receivedHeatingSetpoint : meta.state.current_heating_setpoint;

                const receivedAwayDurationSet = receivedData[awayDurationSetDP];
                const currentAwayDurationSet = receivedAwayDurationSet !== undefined ? receivedAwayDurationSet : meta.state.away_duration_set;

                const receivedBoostDurationSet = receivedData[boostDurationSetDP];
                const currentBoostDurationSet = receivedBoostDurationSet !== undefined ? receivedBoostDurationSet : meta.state.boost_duration_set;

                // Read config temperatures needed for comparisons
                const comfortTemperature = meta.state.comfort_temperature;
                const ecoTemperature = meta.state.eco_temperature;
                const sleepTemperature = meta.state.sleep_temperature;
                const maxTemperature = meta.state.max_temperature;

                // *** Initialize Result Variables ***
                const result = {};
                let calculatedSystemMode = meta.state.system_mode ?? MqttSystemMode.Auto; // Default to Auto if unknown
                let calculatedPreset = meta.state.preset ?? MqttPreset.Manual;         // Default to Manual if unknown
                let derivedHeatingSetpoint = currentHeatingSetpoint; // Start with the current known/received setpoint

                let stateHandled = false; // Flag to track if the state was determined

                // *** START OF REFACTORED LOGIC ***

                // Priority 0: Check for active Boost or Away (based on duration timers)
                if (currentBoostDurationSet !== undefined && currentBoostDurationSet > 0) {
                    calculatedSystemMode = MqttSystemMode.Auto;
                    calculatedPreset = MqttPreset.Boost;
                    derivedHeatingSetpoint = maxTemperature; // Boost mode heats to max temp
                    result.boost_till = meta.state.boost_till ?? 'calculating...';
                    // Store setpoint *before* boost only if boost *just* started OR if setpoint changed during boost confirmation
                    if ((receivedBoostDurationSet !== undefined && meta.state.boost_duration_set === 0) || receivedHeatingSetpoint !== undefined) {
                        result.setpoint_after_boost = currentHeatingSetpoint;
                    } else if (meta.state.setpoint_after_boost !== undefined) {
                        result.setpoint_after_boost = meta.state.setpoint_after_boost;
                    }
                    result.away_till = 'off'; // Boost cancels away
                    stateHandled = true;
                } else if (currentAwayDurationSet !== undefined && currentAwayDurationSet > 0) {
                    calculatedSystemMode = MqttSystemMode.Auto;
                    calculatedPreset = MqttPreset.Away;
                    derivedHeatingSetpoint = sleepTemperature; // Away mode uses sleep temperature
                    result.away_till = meta.state.away_till ?? 'calculating...';
                    result.boost_till = 'off'; // Away cancels boost
                    result.setpoint_after_boost = undefined; // Away cancels boost restore logic
                    stateHandled = true;
                } else {
                     // Clear boost/away indicators if timers are 0 or undefined
                     result.boost_till = 'off';
                     result.away_till = 'off';
                     // If boost just ended (received duration 0), restore the setpoint
                     if (receivedBoostDurationSet === 0 && meta.state.setpoint_after_boost !== undefined) {
                        derivedHeatingSetpoint = meta.state.setpoint_after_boost;
                        result.setpoint_after_boost = undefined; // Clear the stored value
                        // When Boot expires Device goes back to Programming Mode (=>Auto/Schedule)
                        calculatedPreset = MqttPreset.Schedule;
                     } else {
                        result.setpoint_after_boost = undefined; // Clear if boost wasn't active anyway
                     }
                }

                // Priority 1: Device explicitly sent its mode (`deviceModeDP` present)
                if (!stateHandled && receivedTuyaDeviceMode !== undefined) {
                    switch (receivedTuyaDeviceMode) {
                        case DeviceMode.Off:
                            calculatedSystemMode = MqttSystemMode.Off;
                            calculatedPreset = MqttPreset.None;
                            break;
                        case DeviceMode.On: // Treat 'On' as simple Heat mode
                            calculatedSystemMode = MqttSystemMode.Heat;
                            calculatedPreset = MqttPreset.None;
                            break;
                        case DeviceMode.Comfort:
                            calculatedSystemMode = MqttSystemMode.Auto;
                            calculatedPreset = MqttPreset.Comfort;
                            if (currentHeatingSetpoint !== comfortTemperature) derivedHeatingSetpoint = comfortTemperature;
                            break;
                        case DeviceMode.Eco:
                            calculatedSystemMode = MqttSystemMode.Auto;
                            calculatedPreset = MqttPreset.Eco;
                            if (currentHeatingSetpoint !== ecoTemperature) derivedHeatingSetpoint = ecoTemperature;
                            break;
                         case DeviceMode.Sleep: // Map device 'sleep' mode to MQTT 'sleep' preset
                            calculatedSystemMode = MqttSystemMode.Auto;
                            calculatedPreset = MqttPreset.Sleep;
                            if (currentHeatingSetpoint !== sleepTemperature) derivedHeatingSetpoint = sleepTemperature;
                            break;
                        case DeviceMode.Auto: // Device 'auto' means schedule is active
                            calculatedSystemMode = MqttSystemMode.Auto;
                            calculatedPreset = MqttPreset.Schedule;
                            const scheduledTemp = getActiveScheduleTemperature(meta);
                            if (scheduledTemp !== null && derivedHeatingSetpoint !== scheduledTemp) {
                                derivedHeatingSetpoint = scheduledTemp;
                            }
                            break;
                        default:
                            console.warn(`TRV602Z(fz): Received unknown device_mode: ${receivedTuyaDeviceMode}`);
                            calculatedSystemMode = MqttSystemMode.Auto;
                            calculatedPreset = MqttPreset.Manual;
                            break;
                    }
                    stateHandled = true;
                }

                // Priority 2: Only Setpoint Changed (`currentHeatingSetpointDP` present, `deviceModeDP` absent)
                if (!stateHandled && receivedHeatingSetpoint !== undefined && receivedTuyaDeviceMode === undefined) {
                    const previousDeviceMode = meta.state.device_mode;

                    if (previousDeviceMode === DeviceMode.Auto) {
                        // Was in Schedule mode, now temp changed manually
                        const scheduledTemp = getActiveScheduleTemperature(meta);
                        if (scheduledTemp !== null && Math.abs(receivedHeatingSetpoint - scheduledTemp) < 0.1) {
                             calculatedSystemMode = MqttSystemMode.Auto;
                             calculatedPreset = MqttPreset.Schedule;
                        } else {
                             calculatedSystemMode = MqttSystemMode.Auto;
                             calculatedPreset = MqttPreset.Complex;
                        }
                    } else {
                        // Was NOT in Schedule mode, temp changed manually
                        calculatedSystemMode = MqttSystemMode.Auto; // Manual temp setting implies 'Auto' system mode
                        // Check if the new temperature matches a known preset temperature
                        if (comfortTemperature !== undefined && Math.abs(receivedHeatingSetpoint - comfortTemperature) < 0.1) {
                            calculatedPreset = MqttPreset.Comfort;
                        } else if (ecoTemperature !== undefined && Math.abs(receivedHeatingSetpoint - ecoTemperature) < 0.1) {
                            calculatedPreset = MqttPreset.Eco;
                        } else if (sleepTemperature !== undefined && Math.abs(receivedHeatingSetpoint - sleepTemperature) < 0.1) {
                            calculatedPreset = MqttPreset.Sleep;
                        } else {
                            calculatedPreset = MqttPreset.Manual;
                        }
                    }
                    derivedHeatingSetpoint = receivedHeatingSetpoint;
                    stateHandled = true;
                }

                // If state wasn't handled by any specific logic
                if (!stateHandled) {
                     // State is determined by initial values or Boost/Away logic outcome above
                }


                // *** Final Result Population ***
                result.system_mode = calculatedSystemMode;
                result.preset = calculatedPreset;
                result.current_heating_setpoint = derivedHeatingSetpoint;

                // Add diagnostic running_mode explanation
                result.running_mode = `(${result.system_mode}|${result.preset ?? 'none'}) derived from: ` +
                                      `rcvdMode=${receivedTuyaDeviceMode ?? 'N/A'}, rcvdSp=${receivedHeatingSetpoint ?? 'N/A'}, ` +
                                      `curBoost=${currentBoostDurationSet ?? 'N/A'}, curAway=${currentAwayDurationSet ?? 'N/A'}, ` +
                                      `lastDevMode=${meta.state.device_mode ?? 'N/A'}`;

                if (receivedTuyaDeviceMode !== undefined) {
                    result.device_mode = receivedTuyaDeviceMode;
                }
                if (receivedBoostDurationSet !== undefined) {
                    result.boost_duration_set = receivedBoostDurationSet;
                }
                if (receivedAwayDurationSet !== undefined) {
                    result.away_duration_set = receivedAwayDurationSet;
                }


                // *** Logging & Return ***
				console.info('result.system_mode=' + result.system_mode);
				console.info('result.preset=' + result.preset);
				console.info('result.current_heating_setpoint=' + result.current_heating_setpoint);
				console.info('result.running_mode=' + result.running_mode);

				return result;
            },
             // *** END OF REFACTORED convert FUNCTION ***
        },
    ],
    toZigbee: [
        {
            key: ['boost_duration', 'away_duration'],
            // @ts-ignore
            convertSet: async (entity, key, value, meta) => {
                 if (key === 'boost_duration') {
                    (0, assert_1.default)(typeof value === 'number' && value >= 1 && value <= 120, 'boost_duration must be between 1 and 120 minutes');
                    return { state: { boost_duration: value } };
                 } else {
                    (0, assert_1.default)(typeof value === 'number' && value >= 1 && value <= 364, 'away_duration must be between 1 and 364 days');
                    return { state: { away_duration: value } };
                 }
            },
        },
        {
            key: ['system_mode', 'preset'],
            // @ts-ignore
            convertSet: async (entity, key, value, meta) => {
                const deviceModeDP = 2;
                const currentHeatingSetpointDP = 4;
                const awayDurationSetDP = 117;
                const boostDurationSetDP = 118;

                const MqttSystemMode = { Off: "off", Heat: "heat", Auto: "auto" };
                const MqttPreset = { Manual: "manual", Comfort: "comfort", Eco: "eco", Sleep: "sleep", Away: "away", Boost: "boost", Schedule: "schedule", Complex: "complex", None: null };
                const TuyaDeviceMode = { Off: 0, Sleep: 1, Eco: 2, Comfort: 3, Auto: 4, On: 5 };

                const result = { state: {} };

                (0, assert_1.default)(meta.state.min_temperature !== undefined, 'Min temperature config is missing');
                (0, assert_1.default)(meta.state.max_temperature !== undefined, 'Max temperature config is missing');
                (0, assert_1.default)(meta.state.comfort_temperature !== undefined, 'Comfort temperature config is missing');
                (0, assert_1.default)(meta.state.eco_temperature !== undefined, 'Eco temperature config is missing');
                (0, assert_1.default)(meta.state.sleep_temperature !== undefined, 'Sleep temperature config is missing (used for Away)');
                (0, assert_1.default)(meta.state.current_heating_setpoint !== undefined, 'Current heating setpoint is not available');

                let targetSystemMode = key === 'system_mode' ? value : meta.state.system_mode;
                let targetPreset = key === 'preset' ? value : meta.state.preset;

                // Handle dependencies between system_mode and preset
                if (key === 'system_mode') {
                    if (value === MqttSystemMode.Auto) {
                        targetPreset = MqttPreset.Manual;
                    } else {
                        targetPreset = MqttPreset.None;
                    }
                } else if (key === 'preset') {
                    if (value === MqttPreset.Complex) throw new Error("Preset 'complex' is read-only and cannot be set.");
                    if (value !== MqttPreset.None && targetSystemMode !== MqttSystemMode.Auto) {
                         console.warn(`TRV602Z(tz): Preset '${value}' requires system_mode 'auto'. Forcing system_mode to 'auto'.`);
                         targetSystemMode = MqttSystemMode.Auto;
                         result.state.system_mode = MqttSystemMode.Auto;
                    }
                     if (value === MqttPreset.None && targetSystemMode === MqttSystemMode.Auto) {
                         targetPreset = MqttPreset.Manual;
                     }
                }

                // --- Cancel active Boost/Away if the new target preset is not Boost/Away ---
                const currentBoostDurationSet = meta.state.boost_duration_set ?? 0;
                const currentAwayDurationSet = meta.state.away_duration_set ?? 0;

                if (targetPreset !== MqttPreset.Boost && currentBoostDurationSet > 0) {
                    console.log(`TRV602Z(tz): Cancelling Boost mode (DP ${boostDurationSetDP}=0).`);
                    await tuya.sendDataPointValue(entity, boostDurationSetDP, 0);
                    result.state.boost_duration_set = 0;
                    result.state.boost_till = 'off';
                    if (meta.state.setpoint_after_boost !== undefined) {
                        console.log(`TRV602Z(tz): Restoring setpoint to ${meta.state.setpoint_after_boost} after boost cancellation.`);
                        await tuya.sendDataPointValue(entity, currentHeatingSetpointDP, Math.round(meta.state.setpoint_after_boost * 10));
                        result.state.current_heating_setpoint = meta.state.setpoint_after_boost;
                        result.state.setpoint_after_boost = undefined;
                    }
                }
                if (targetPreset !== MqttPreset.Away && currentAwayDurationSet > 0) {
                    console.log(`TRV602Z(tz): Cancelling Away mode (DP ${awayDurationSetDP}=0).`);
                    await tuya.sendDataPointValue(entity, awayDurationSetDP, 0);
                    result.state.away_duration_set = 0;
                    result.state.away_till = 'off';
                }

                // --- Apply target system_mode and preset ---
                switch (targetSystemMode) {
                    case MqttSystemMode.Off:
                        console.log(`TRV602Z(tz): Setting system_mode to Off (DP ${deviceModeDP}=${TuyaDeviceMode.Off}).`);
                        await tuya.sendDataPointEnum(entity, deviceModeDP, TuyaDeviceMode.Off);
                        result.state.device_mode = 'off';
                        result.state.system_mode = MqttSystemMode.Off;
                        result.state.preset = MqttPreset.None;
                        break;

                    case MqttSystemMode.Heat:
                        console.log(`TRV602Z(tz): Setting system_mode to Heat (DP ${deviceModeDP}=${TuyaDeviceMode.On}).`);
                        await tuya.sendDataPointEnum(entity, deviceModeDP, TuyaDeviceMode.On);
                        result.state.device_mode = 'on';
                        result.state.system_mode = MqttSystemMode.Heat;
                        result.state.preset = MqttPreset.None;
                        break;

                    case MqttSystemMode.Auto:
                        result.state.system_mode = MqttSystemMode.Auto;
                        switch (targetPreset) {
                            case MqttPreset.Manual:
                                console.log(`TRV602Z(tz): Setting preset to Manual (via DP ${deviceModeDP}=${TuyaDeviceMode.Comfort}, keeping current temp).`);
                                await tuya.sendDataPointEnum(entity, deviceModeDP, TuyaDeviceMode.Comfort);
                                result.state.device_mode = 'comfort';
                                result.state.preset = MqttPreset.Manual;
                                break;
                            case MqttPreset.Comfort:
                                console.log(`TRV602Z(tz): Setting preset to Comfort (DP ${deviceModeDP}=${TuyaDeviceMode.Comfort}, DP ${currentHeatingSetpointDP}=${meta.state.comfort_temperature}).`);
                                await tuya.sendDataPointEnum(entity, deviceModeDP, TuyaDeviceMode.Comfort);
                                await tuya.sendDataPointValue(entity, currentHeatingSetpointDP, Math.round(meta.state.comfort_temperature * 10));
                                result.state.current_heating_setpoint = meta.state.comfort_temperature;
                                result.state.device_mode = 'comfort';
                                result.state.preset = MqttPreset.Comfort;
                                break;
                            case MqttPreset.Eco:
                                console.log(`TRV602Z(tz): Setting preset to Eco (DP ${deviceModeDP}=${TuyaDeviceMode.Eco}, DP ${currentHeatingSetpointDP}=${meta.state.eco_temperature}).`);
                                await tuya.sendDataPointEnum(entity, deviceModeDP, TuyaDeviceMode.Eco);
                                await tuya.sendDataPointValue(entity, currentHeatingSetpointDP, Math.round(meta.state.eco_temperature * 10));
                                result.state.current_heating_setpoint = meta.state.eco_temperature;
                                result.state.device_mode = 'eco';
                                result.state.preset = MqttPreset.Eco;
                                break;
                            case MqttPreset.Sleep:
                                console.log(`TRV602Z(tz): Setting preset to Sleep (DP ${deviceModeDP}=${TuyaDeviceMode.Sleep}, DP ${currentHeatingSetpointDP}=${meta.state.sleep_temperature}).`);
                                await tuya.sendDataPointEnum(entity, deviceModeDP, TuyaDeviceMode.Sleep);
                                await tuya.sendDataPointValue(entity, currentHeatingSetpointDP, Math.round(meta.state.sleep_temperature * 10));
                                result.state.current_heating_setpoint = meta.state.sleep_temperature;
                                result.state.device_mode = 'sleep';
                                result.state.preset = MqttPreset.Sleep;
                                break;
                            case MqttPreset.Schedule:
                                console.log(`TRV602Z(tz): Setting preset to Schedule (DP ${deviceModeDP}=${TuyaDeviceMode.Auto}).`);
                                await tuya.sendDataPointEnum(entity, deviceModeDP, TuyaDeviceMode.Auto);
                                result.state.device_mode = 'auto';
                                result.state.preset = MqttPreset.Schedule;
                                break;
                            case MqttPreset.Boost:
                                (0, assert_1.default)(meta.state.boost_duration !== undefined && meta.state.boost_duration > 0, 'Boost duration (boost_duration) must be configured and > 0');
                                //if (currentBoostDurationSet === 0) {
                                //     result.state.setpoint_after_boost = meta.state.current_heating_setpoint;
                                //     console.log(`TRV602Z(tz): Storing setpoint ${result.state.setpoint_after_boost} before activating Boost.`);
                                //}
                                const boostDurationMinutes = meta.state.boost_duration;
                                console.log(`TRV602Z(tz): Activating Boost for ${boostDurationMinutes} minutes (DP ${boostDurationSetDP}=${boostDurationMinutes}).`);
                                await tuya.sendDataPointEnum(entity, deviceModeDP, TuyaDeviceMode.Auto);
								await tuya.sendDataPointValue(entity, boostDurationSetDP, boostDurationMinutes);
                                result.state.boost_duration_set = boostDurationMinutes;
                                result.state.preset = MqttPreset.Boost;
                                const boostTill = new Date();
                                boostTill.setMinutes(boostTill.getMinutes() + boostDurationMinutes);
                                result.state.boost_till = boostTill.toLocaleString();
                                break;
                            case MqttPreset.Away:
                                (0, assert_1.default)(meta.state.away_duration !== undefined && meta.state.away_duration > 0, 'Away duration (away_duration) must be configured and > 0');
                                const awayDurationDays = meta.state.away_duration;
                                console.log(`TRV602Z(tz): Activating Away for ${awayDurationDays} days (DP ${awayDurationSetDP}=${awayDurationDays}).`);
                                console.log(`TRV602Z(tz): Setting Away temperature (DP ${currentHeatingSetpointDP}=${meta.state.sleep_temperature}).`);
                                await tuya.sendDataPointValue(entity, currentHeatingSetpointDP, Math.round(meta.state.sleep_temperature * 10));
                                result.state.current_heating_setpoint = meta.state.sleep_temperature;
                                await tuya.sendDataPointValue(entity, awayDurationSetDP, awayDurationDays);
                                result.state.away_duration_set = awayDurationDays;
                                result.state.preset = MqttPreset.Away;
                                const awayTill = new Date();
                                awayTill.setDate(awayTill.getDate() + awayDurationDays);
                                result.state.away_till = awayTill.toLocaleString();
                                break;
                            default:
                                console.warn(`TRV602Z(tz): Invalid or unsupported preset '${targetPreset}' in Auto mode. Defaulting to Manual.`);
                                await tuya.sendDataPointEnum(entity, deviceModeDP, TuyaDeviceMode.Comfort);
                                result.state.device_mode = 'comfort';
                                result.state.preset = MqttPreset.Manual;
                                break;
                        }
                        break;

                    default:
                         throw new Error('Invalid system mode value: ' + targetSystemMode);
                }

                return result;
            },
        },
        tuya.tz.datapoints,
    ],
    ota: true,
    exposes: [
        e.battery(), //! dp 6
        e //! dp 35
            .enum('fault', ea.STATE, ['clear', 'fault_sensor', 'fault_motor', 'fault_low_batt', 'fault_ug_low_batt', 'fault_poor_bat'])
            .withCategory('diagnostic')
            .withDescription('Fault status of the device (clear = nothing)'),
        e.child_lock(), //! dp 7
        e //! dp 114
            .position().withDescription('Current valve opening %')
            .withCategory('diagnostic'), 
        e //! dp 14
            .binary('window_detection', ea.STATE_SET, 'ON', 'OFF')
            .withDescription('Enables/disables window detection on the device')
            .withCategory('config'),
        e.window_open(), //! dp 15

        // *** Climate Control Exposures (Refactored Modes/Presets) ***
        e
            .climate()
            .withLocalTemperature(ea.STATE) //! dp 5
            .withSetpoint('current_heating_setpoint', 5, 35, 0.5, ea.STATE_SET) //! dp 4
            .withLocalTemperatureCalibration(-10, 10, 0.1, ea.STATE_SET) //! dp 47
            // .withPiHeatingDemand(ea.STATE) //! dp 114
            .withSystemMode(['off', 'heat', 'auto'], ea.STATE_SET) //! dp 2, // NEW MODES
            // OLD: .withPreset(['sleep', 'eco', 'comfort', '100%', 'away', 'boost']) //! none (null) is defined by default  //! dp 2
            .withPreset(['manual', 'comfort', 'eco', 'sleep', 'away', 'boost', 'schedule', 'complex'], ea.STATE_SET, 'Select TRV preset (only active in Auto mode). Complex is read-only.') //! dp 2 // NEW PRESETS
            .withRunningState(['idle', 'heat'], ea.STATE), //! dp 3

        e
            .enum('device_mode', ea.STATE, ['off', 'sleep', 'eco', 'comfort', 'auto', 'on'])
            .withDescription('Actual raw TRV running mode reported by the device')
            .withCategory('diagnostic'), //! dp 2
        e.text('running_mode', ea.STATE).withDescription('Explanation of the current running mode').withCategory('diagnostic'),
        ...tuya.exposes
            .scheduleAllDays(
        //! dp 102-108
        ea.STATE_SET, '00:00/16.0 08:30/23 12:30/comfort 14:00/eco 18:00/sleep 22:00/eco". ' +
            'Up to 6 transitions of format: HH:MM/<temp or mode>. Configurable modes: "sleep|eco|comfort')
            // @ts-ignore
            .map((text) => text.withCategory('config')),
        e
            .max_temperature() //! dp 9
            .withCategory('config') // todo: remove when implemented in the repo
            .withValueMin(20)
            .withValueMax(35)
            .withValueStep(1)
            .withDescription('Upper temperature limit for setpoint'),
        e
            .min_temperature() //! dp 10
            .withCategory('config') // todo: remove when implemented in the repo
            .withValueMin(5)
            .withValueMax(15)
            .withValueStep(1)
            .withDescription('Lower temperature limit for setpoint'),
        e
            .comfort_temperature() //! dp 119
            .withCategory('config') // todo: remove when implemented in the repo
            .withValueMin(5)
            .withValueMax(35)
            .withValueStep(0.5)
            .withDescription('Temperature used for Comfort preset'),
        e
            .eco_temperature() //! dp 120
            .withCategory('config') // todo: remove when implemented in the repo
            .withValueMin(5)
            .withValueMax(35)
            .withValueStep(0.5)
            .withDescription('Temperature used for Eco preset'),
        e //! dp 121
            .numeric('sleep_temperature', ea.STATE_SET)
            .withCategory('config')
            .withUnit('°C')
            .withValueMin(5)
            .withValueMax(35)
            .withValueStep(0.5)
            .withDescription('Temperature used for Sleep preset and Away mode'),
        e //! dp 111
            .enum('display_brightness', ea.STATE_SET, ['high', 'medium', 'low'])
            .withCategory('config'),
        e //! dp 113
            .enum('screen_orientation', ea.STATE_SET, ['up', 'down', 'left', 'right'])
            .withCategory('config')
            .withDescription('Screen rotation (*may not be supported by all devices)'),
        e //! dp 127
            .enum('regulation_mode', ea.STATE_SET, ['pid', 'hysteresis'])
            .withCategory('config')
            .withDescription('>> PID Mode: The TRV constantly adjusts heating to keep the temperature as close as possible to the target. This improves comfort and reduces temperature swings but uses more energy because it makes continuous adjustments. ' +
            '>> Hysteresis Mode: The TRV turns heating on when the temperature drops below a set point and off when it rises above it, using a buffer (Hysteresis Threshold) to prevent frequent switching. This provides stable and reliable control.'),
        e //! dp 115
            .numeric('hysteresis_threshold', ea.STATE_SET)
            .withCategory('config')
            .withUnit('°C')
            .withValueMin(0.5)
            .withValueMax(5)
            .withValueStep(0.1)
            .withDescription('Only used in Hysteresis Regulation Mode. The offset from the target temperature in which the temperature has to change for the heating state to change. This is to prevent erratically turning on/off when the temperature is close to the target'),
        e //! dp 110
            .enum('motor_thrust', ea.STATE_SET, ['strong', 'middle', 'weak'])
            .withCategory('config')
            .withDescription('* Might be not supported for some devices'),
        e //! dp virtual
            .text('boost_till', ea.STATE)
            .withCategory('diagnostic')
            .withDescription('Approximate time when Boost mode will end'),
        e //! dp 118
            .numeric('boost_duration_set', ea.STATE)
            .withCategory('diagnostic')
            .withUnit('minutes')
            .withDescription('Currently active Boost duration (0 if not active)'),
        e //! dp virtual
            .numeric('boost_duration', ea.SET)
            .withCategory('config')
            .withUnit('minutes')
            .withDescription('Duration for which the Boost mode will be activated. The thermostat will return to the Auto mode (or Away mode if it was active) after the set duration')
            .withValueMin(1)
            .withValueMax(120)
            .withPreset('15 min', 15, '15 minutes')
            .withPreset('30 min', 30, '30 minutes')
            .withPreset('1 hour', 60, '1 hour')
            .withPreset('1.5 hours', 90, '1.5 hours')
            .withPreset('2 hours', 120, '2 hours'),
        e //! dp virtual
            .text('away_till', ea.STATE)
            .withCategory('diagnostic')
            .withDescription('Approximate date when Away mode will end'),
        e //! dp 117
            .numeric('away_duration_set', ea.STATE)
            .withCategory('diagnostic')
            .withUnit('days')
            .withDescription('Currently active Away duration (0 if not active)'),
        e //! dp virtual
            .numeric('away_duration', ea.STATE_SET)
            .withCategory('config')
            .withUnit('days')
            .withDescription('Duration for which the Away mode will be activated. The thermostat will use the Sleep mode temperature setting and return to the previous mode after the set duration')
            .withValueMin(1)
            .withValueMax(364),
        e //! dp 122
            .binary('frost_protection', ea.STATE_SET, 'ON', 'OFF')
            .withDescription('To be used in Off mode. The valve will open when the room temperature is lower than 5 °C and close when it rises to 7 °C')
            .withCategory('config'),
    ],
    meta: {
        tuyaDatapoints: [
            [
                2,
                'device_mode',
                tuya.valueConverterBasic.lookup({
                    off: tuya.enum(0),
                    sleep: tuya.enum(1),
                    eco: tuya.enum(2),
                    comfort: tuya.enum(3),
                    auto: tuya.enum(4),
                    on: tuya.enum(5),
                }),
            ],
            [3, 'running_state', tuya.valueConverterBasic.lookup({ heat: 1, idle: 0 })],
            [4, 'current_heating_setpoint', tuya.valueConverter.divideBy10],
            [5, 'local_temperature', tuya.valueConverter.divideBy10],
            [6, 'battery', tuya.valueConverter.raw],
            [
                7,
                'child_lock',
                tuya.valueConverterBasic.lookup({
                    LOCK: true,
                    UNLOCK: false,
                }),
            ],
            [9, 'max_temperature', tuya.valueConverter.divideBy10],
            [10, 'min_temperature', tuya.valueConverter.divideBy10],
            [14, 'window_detection', tuya.valueConverter.onOff],
            [15, 'window_open', tuya.valueConverter.trueFalseEnum1],
            [
                35,
                'fault',
                tuya.valueConverterBasic.lookup({
                    clear: 0, // 00000
                    fault_sensor: 1, // 00001
                    fault_motor: 2, // 00010
                    fault_low_batt: 4, // 00100
                    fault_ug_low_batt: 8, // 01000
                    fault_poor_bat: 16, // 10000
                }), //? combination of faults?
            ],
            [47, 'local_temperature_calibration', tuya.valueConverter.localTempCalibration1],
            [102, 'schedule_monday', customValueConverter.scheduleWithDay(1)],
            [103, 'schedule_tuesday', customValueConverter.scheduleWithDay(2)],
            [104, 'schedule_wednesday', customValueConverter.scheduleWithDay(3)],
            [105, 'schedule_thursday', customValueConverter.scheduleWithDay(4)],
            [106, 'schedule_friday', customValueConverter.scheduleWithDay(5)],
            [107, 'schedule_saturday', customValueConverter.scheduleWithDay(6)],
            [108, 'schedule_sunday', customValueConverter.scheduleWithDay(7)],
            [
                110,
                'motor_thrust',
                tuya.valueConverterBasic.lookup({
                    strong: tuya.enum(0),
                    middle: tuya.enum(1),
                    weak: tuya.enum(2),
                }),
            ],
            [
                111,
                'display_brightness',
                tuya.valueConverterBasic.lookup({
                    high: tuya.enum(0),
                    medium: tuya.enum(1),
                    low: tuya.enum(2),
                }),
            ],
            [
                113,
                'screen_orientation',
                tuya.valueConverterBasic.lookup({ up: tuya.enum(0), down: tuya.enum(1), left: tuya.enum(2), right: tuya.enum(3) }),
            ],
            [114, 'position', tuya.valueConverter.divideBy10],
            [115, 'hysteresis_threshold', tuya.valueConverter.divideBy10],
            [117, 'away_duration_set', tuya.valueConverter.raw],
            [118, 'boost_duration_set', tuya.valueConverter.raw],
            [119, 'comfort_temperature', tuya.valueConverter.divideBy10],
            [120, 'eco_temperature', tuya.valueConverter.divideBy10],
            [121, 'sleep_temperature', tuya.valueConverter.divideBy10],
            [122, 'frost_protection', tuya.valueConverter.onOff],
            [
                127,
                'regulation_mode',
                tuya.valueConverterBasic.lookup({
                    pid: tuya.enum(0),
                    hysteresis: tuya.enum(1),
                }),
            ],
        ],
    },
};
module.exports = definition;
