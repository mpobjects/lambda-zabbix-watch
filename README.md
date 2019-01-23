# Lambda Zabbix Watch
AWS Lamba function to watch a zabbix server and report host status in DynamoDB. It records all monitored hosts, and currently active events and maintenance.

# Configuration

The handler for this function is `index.watchZabbix`. And requires at least NodeJS 8.10.

As input for the lamba function a cloud watch event can be used with a given rate, e.g. every 5 minutes.

## Role Permissions

This lamba function requires the `dynamodb:BatchWriteItem` privilege to the used DynamoDB tables.

## DynamoDB

### Host table

Will be used to store the host record.

Name: `zabbix.hosts`

Key: `hostid`

### Events table

Will be used to store the active events.

Name: `zabbit.events`

Key: `eventid`

Sort key: `hostid`

## Environment Variables

|Key|Description|
|---|---------|
|`ZABBIX_URL`|URL to the Zabbix API.|
|`ZABBIX_AUTH`|Zabbix API key to used.|
|`ZABBIX_HOSTID`|Host ID of the Zabbix server (main agent). This will be used as host to report unavailablity of the zabbix server.|
|`MIN_SEVERITY`|Optional, default `4`. Minimum severity to check for active events.|

# Stored Data

## Hosts

```
{
        hostid: hostid,
        name: name,
        status: 200,
        severity: 0-7,
        timestamp: unix epoch in seconds when this host was last seen,
        maintenance: true/false
        maintenanceFrom: unix epoch in seconds
}
```

### Status Values
|Value|Description|
|-----|-----------|
|200|Everything is ok|
|500|An active trigger|
|503|Host cannot be reached|

## Events

```
{
        eventid: eventid,
        hostid: hostid,
        type: event type,
        message: a description,
        timestamp: unix epoch in seconds of the zabbix event,
        maintenance: true/false if the host is in maintenance,
        triggerid: triggerid,
        severity: 0-7,
        acknowledged: true/false
}
```

Not all fields are always populated, most of the fields are used for trigger events. The first five fields are generally populated.

### Event Types
|Type|Description|
|----|-----------|
|trigger|A zabbix trigger produced an event. This sets the host status to 500.|
|agent:zabbix, agent:snmp, agent:jmx|The zabbix agent has an error. Results in the host getting the 503 status.|
|api, api:io|Issue with the zabbix API. The latter is used for connectivity (HTTP) related problems. These events only happen for the main zabbix host and set the status to 503.|


