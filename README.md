# Lambda Zabbix Watch
AWS Lamba function to watch a zabbix server and report host status in DynamoDB. It records all monitored hosts, and currently active events and maintenance.

## Configuration

The handler for this function is `index.watchZabbix`. And requires at least NodeJS 8.10.

As input for the lamba function a cloud watch event can be used with a given rate, e.g. every 5 minutes.

### Role Permissions

This lamba function requires the `dynamodb:BatchWriteItem` privilege to the used DynamoDB tables.

### DynamoDB

#### Host table

Will be used to store the host record.

Name: `zabbix.hosts`

Key: `hostid`

#### Events table

Will be used to store the active events.

Name: `zabbit.events`

Key: `eventid`

Sort key: `hostid`

### Environment Variables

|Key|Description|
|---|---------|
|`ZABBIX_URL`|URL to the Zabbix API.|
|`ZABBIX_AUTH`|Zabbix API key to used.|
|`ZABBIX_HOSTID`|Host ID of the Zabbix server (main agent). This will be used as host to report unavailablity of the zabbix server.|
|`MIN_SEVERITY`|Optional, default `4`. Minimum severity to check for active events.|
