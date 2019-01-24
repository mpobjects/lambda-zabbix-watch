var AWS = require('aws-sdk');
var rp = require('request-promise-native');

/** Everything is ok */
const STATUS_OK = 200;
/** Host is offline */
const STATUS_OFFLINE = 503;
/** Host is online, but here is a problem */
const STATUS_PROBLEM = 500;

/** Used to ensure unique generated events ids */
let eventIdCounter = 0;

function validateConfig() {
    let valid = true;
    if (!process.env.ZABBIX_URL) {
        console.error("ZABBIX_URL not defined");
        valid = false;
    }
    if (!process.env.ZABBIX_AUTH) {
        console.error("ZABBIX_AUTH not defined");
        valid = false;
    }
    if (!process.env.ZABBIX_HOSTID) {
        console.error("ZABBIX_HOSTID not defined");
        valid = false;
    }
    return valid;
}

async function callZabbix(requestData) {
    requestData["jsonrpc"] = "2.0";
    requestData["auth"] = process.env.ZABBIX_AUTH;
    requestData["id"] = 1;
    let opt = {
        method: 'POST',
        uri: process.env.ZABBIX_URL,
        body: requestData,
        json: true,
        resolveWithFullResponse: true
    }
    return rp(opt)
        .then(response => {
            if (response.body.error) {
                response.error = "400 Bad Request";
                response.statusCode = 400;
                throw response;
            }
            else {
                return response.body;
            }
        });
}

function getTimestamp() {
    return Math.round(new Date().getTime()/1000);
}

/** Internal event identifiers */
function createEventId() {
    return "E:"+(new Date().getTime())+":"+(++eventIdCounter);
}

function processHostData(record) {
    let host = {
        hostid: record.hostid,
        name: record.host,
        status: STATUS_OK,
        severity: 0,
        timestamp: getTimestamp(),
        maintenance: record.maintenance_status === "1",
        events: [],
    };
    if (host.maintenance) {
        host.maintenanceFrom = parseInt(record.maintenance_from);
    }
    if (record.available === "2") {
        host.status = STATUS_OFFLINE;
        host.events.push({
            eventid: createEventId(),
            type: "agent:zabbix",
            message: record.error,
            timestamp: parseInt(record.errors_from),
            maintenance: host.maintenance
        });
    }
    if (record.jmx_available === "2") {
        host.status = STATUS_OFFLINE;
        host.events.push({
            eventid: createEventId(),
            type: "agent:jmx",
            message: record.jmx_error,
            timestamp: parseInt(record.jmx_errors_from),
            maintenance: host.maintenance
        });
    }
    if (record.snmp_available === "2") {
        host.status = STATUS_OFFLINE;
        host.events.push({
            eventid: createEventId(),
            type: "agent:snmp",
            message: record.snmp_error,
            timestamp: parseInt(record.snmp_errors_from),
            maintenance: host.maintenance
        });
    }
    return host;
}

function processHostDataResult(hosts, data) {
    for (let i = 0; i < data.result.length; ++i) {
        let host = processHostData(data.result[i]);
        hosts[host.hostid] = host;
    }
}

function registerServerError(hosts, response) {
    let record = {
        hostid: process.env.ZABBIX_HOSTID,
        status: STATUS_OFFLINE,
        timestamp: getTimestamp(),
        maintenance: false,
        events: []
    }
    if (response.body && response.body.jsonrpc) {
        console.error("API error: "+JSON.stringify(response.body.error));
        record.events.push({
            eventid: createEventId(),
            type: "api",
            message: "["+response.body.error.code+"] "+response.body.error.message+" "+response.body.error.data,
            timestamp: getTimestamp(),
            maintenance: record.maintenance
        });
    }
    else {
        console.error("IO error: "+response);
        record.events.push({
            eventid: createEventId(),
            type: "api:io",
            message: ""+response,
            timestamp: getTimestamp(),
            maintenance: record.maintenance
        });
    }
    hosts[process.env.ZABBIX_HOSTID] = record;
}

async function fetchHosts(hosts) {
    console.info("Fetching hosts...");
    let req = {
        "method": "host.get",
        "params": {
            "with_items": true,
            "monitored_hosts": true
        }
    };
    return callZabbix(req)
        .then(data => {
            processHostDataResult(hosts, data);
            return true;
        })
        .catch(err => {
            registerServerError(hosts, err);
            return false;
        });
}

function processHostEvent(host, event) {
    let record = {
        eventid: event.lastEvent.eventid,
        type: 'trigger',
        message: event.description,
        timestamp: parseInt(event.lastchange),
        maintenance: host.maintenance,
        triggerid: event.triggerid,
        severity: parseInt(event.priority),
        acknowledged: event.lastEvent.acknowledged === "1"
    };
    host.events.push(record);
    if (host.status === STATUS_OK) {
        host.status = STATUS_PROBLEM;
    }
    host.severity = Math.max(host.severity, record.severity);
}

function processEventResults(hosts, response) {
    for (let i = 0; i < response.result.length; ++i) {
        let data = response.result[i];
        for (let j = 0; j < data.hosts.length; ++j) {
            let host = hosts[data.hosts[j].hostid];
            processHostEvent(host, data);
        }
    }
}

async function fetchEvents(hosts) {
    console.info("Fetching events...");
    let req = {
        "method": "trigger.get",
        "params": {
            "filter": {
                "value": 1
            },
            "monitored": true,
            "min_severity": process.env.MIN_SEVERITY||4,
            "selectHosts": ["hostid", "host"],
            "selectLastEvent": ["eventid", "acknowledged"],
            "output": "extend",
            "expandDescription": true,
            "expandComment": true
        },
    };
    return callZabbix(req)
        .then(data => {
            processEventResults(hosts, data);
            return true;
        }).catch(err => {
            return false;
        });;
}

function batchWriteItem(dynamodb, param) {
    return new Promise((resolve, reject) => {
        dynamodb.batchWriteItem(param, function(err, data) {
            if (err) {
                reject(err);
            } else {
                resolve(data.ConsumedCapacity[0].CapacityUnits);
            }
        });
    });
}

function batchPutItems(dynamodb, table, batch) {
    if (batch.length == 0) {
        return Promise.resolve(0);
    }
    console.log("Flushing buffer of size "+batch.length+" to table "+table);
    let param = {
        RequestItems: {},
        ReturnConsumedCapacity: "TOTAL"
    };
    param.RequestItems[table] = [];
    for (let i = 0; i < batch.length; ++i) {
        param.RequestItems[table].push({
            PutRequest: {
                Item: AWS.DynamoDB.Converter.marshall(batch[i])
            }
        });
    }
    return batchWriteItem(dynamodb, param);
}

function batchRegisterStatus(dynamodb, hosts) {
    let promises = [];
    let events = [];

    let buffer = [];
    for (const hostid in hosts) {
        const host = hosts[hostid];
        Array.prototype.push.apply(events, host.events);
        delete host.events;
        buffer.push(host);
        if (buffer.length >= 25) {
            promises.push(batchPutItems(dynamodb, "zabbix.hosts", buffer));
            buffer = [];
        }
    }
    promises.push(batchPutItems(dynamodb, "zabbix.hosts", buffer));
    buffer = [];

    for (let i = 0; i < events.length; ++i) {
        buffer.push(events[i]);
        if (buffer.length >= 25) {
            promises.push(batchPutItems(dynamodb, "zabbix.events", buffer));
            buffer = [];
        }
    }
    promises.push(batchPutItems(dynamodb, "zabbix.events", buffer));

    return promises;
}

function registerStatus(hosts) {
    console.info("Registering status...");
    let dynamodb = new AWS.DynamoDB();
    return Promise.all(batchRegisterStatus(dynamodb, hosts));
}

async function watchZabbix(event, context) {
    if (!validateConfig()) {
        return;
    }    

    let hosts = {};
    return fetchHosts(hosts)
        .then(ret => {
            if (ret) {
                return fetchEvents(hosts);
            }
            else {
                return true;
            }
        })
        .then(() => registerStatus(hosts))
        .then(result => {
            console.info("Done.");
            return {
                writes: result.length,
                items: result.reduce((a,b) => a+b, 0)
            };
        });
}

exports.watchZabbix = watchZabbix;

if (require.main === module && process.argv[2] === "test") {
    watchZabbix({}, {}).then(result => console.log(result));
}
