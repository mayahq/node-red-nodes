
/**
 * 
 *Copyright 2016 JS Foundation and other contributors, https://js.foundation/
    Copyright 2013-2016 IBM Corp.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    THIS FILE IS MODIFIED FOR USE WITH Maya Labs' AUTOMATION SUITE
    PLEASE CONTACT humans[at]mayalabs.io FOR ANY COPYRIGHT COMPLAINS/TAKEDOWNS 
 */
module.exports = function(RED) {
    "use strict";
    var reconnect = RED.settings.mysqlReconnectTime || 20000;
    var mysqldb = require('mysql2');
    var mysqldump = require('mysqldump')

    function MySQLNode(n) {
        RED.nodes.createNode(this,n);
        this.host = n.host;
        this.port = n.port;
        this.tz = n.tz || "local";
        this.charset = (n.charset || "UTF8_GENERAL_CI").toUpperCase();

        this.connected = false;
        this.connecting = false;

        this.dbname = n.db;
        this.schemaAccess = n.schemaAccess;
        this.setMaxListeners(0);
        var node = this;

        function checkVer() {
            node.pool.query("SELECT version();", [], function(err, rows, fields) {
                if (err) {
                    node.error(err);
                    node.status({fill:"red",shape:"ring",text:RED._("mysql.status.badping")});
                    doConnect();
                }
            });
        }

        function doConnect() {
            node.connecting = true;
            node.emit("state","connecting");
            if (!node.pool) {
                node.pool = mysqldb.createPool({
                    host : node.host,
                    port : node.port,
                    user : node.credentials.user,
                    password : node.credentials.password,
                    database : node.dbname,
                    timezone : node.tz,
                    insecureAuth: true,
                    multipleStatements: true,
                    connectionLimit: RED.settings.mysqlConnectionLimit || 50,
                    connectTimeout: 30000,
                    charset: node.charset,
                    decimalNumbers: true
                });
            }

            // connection test
            node.pool.getConnection(function(err, connection) {
                node.connecting = false;
                if (err) {
                    node.emit("state",err.code);
                    node.error(err);
                    node.tick = setTimeout(doConnect, reconnect);
                }
                else {
                    node.connected = true;
                    node.emit("state","connected");
                    if (!node.check) { node.check = setInterval(checkVer, 290000); }
                    connection.release();
                }
            });
        }

        node.connect = function() {
            if (!node.connected && !node.connecting) {
                doConnect();
            }
        }

        node.on('close', function(done) {
            if (node.tick) { clearTimeout(node.tick); }
            if (node.check) { clearInterval(node.check); }
            // node.connection.release();
            node.emit("state"," ");
            if (node.connected) {
                node.connected = false;
                node.pool.end(function(err) { done(); });
            }
            else {
                delete node.pool;
                done();
            }

        });
    }
    RED.nodes.registerType("MySQLdatabase",MySQLNode, {
        credentials: {
            user: {type: "text"},
            password: {type: "password"}
        }
    });


    function MysqlDBNodeIn(n) {
        RED.nodes.createNode(this,n);
        this.mydb = n.mydb;
        this.mydbConfig = RED.nodes.getNode(this.mydb);
        console.log("🚀 ~ file: 68-mysql.js:104 ~ MysqlDBNodeIn ~ this.mydbConfig:", this.mydbConfig)
        this.status({});

        const host = this.mydbConfig.host;
        console.log("🚀 ~ file: 68-mysql.js:107 ~ MysqlDBNodeIn ~ host:", host)
        const db = this.mydbConfig.dbname;
        const user = this.mydbConfig.credentials.user;
        const password = this.mydbConfig.credentials.password;
        const schemaAccess = this.mydbConfig.schemaAccess;

        const nodeContext = this.context();

        if (this.mydbConfig) {
            this.mydbConfig.connect();
            var node = this;
            var busy = false;
            var status = {};
            node.mydbConfig.on("state", function(info) {
                if (info === "connecting") { node.status({fill:"grey",shape:"ring",text:info}); }
                else if (info === "connected") { node.status({fill:"green",shape:"dot",text:info}); }
                else {
                    node.status({fill:"red",shape:"ring",text:info});
                }
            });

            async function getMysqlDump(){
                return await mysqldump({
                    connection: {
                      host: host,
                      user: user,
                      password: password,
                      database: db
                    },
                    dump: {
                        tables: [],
                        schema: {
                        autoIncrement: true,
                        engine: true,
                        format: true,
                        table: {
                            ifNotExist: false,
                            dropIfExist: false,
                            charset: 'UTF-8'
                            }
                        },
                        data: false,
                    }
                  })
            }

            if(schemaAccess){
                getMysqlDump().then(result => {
                    nodeContext.set(`${this.mydb}_schema`, result.dump.schema)
                }).catch(err => {
                    status = { fill: "red", shape: "ring", text: RED._("mysql.status.error") + ": " + err.code };
                    this.status(status)
                    this.error(err, err.message)
                })
            } else {
                nodeContext.set(`${this.mydb}_schema`, null)
            }

            node.on("input", function(msg, send, done) {
                send = send || function() { node.send.apply(node,arguments) };
                if (node.mydbConfig.connected) {
                    if(!nodeContext.get(`${node.mydb}_schema`) && msg.payload.renewSchema && typeof msg.payload.renewSchema === 'boolean'){
                        if(schemaAccess === "true"){
                            getMysqlDump().then(result => {
                                nodeContext.set(`${node.mydb}_schema`, result.dump.schema)
                                msg.payload.schema = result.dump.schema;
                            }).catch(err => {
                                status = { fill: "red", shape: "ring", text: RED._("mysql.status.error") + ": " + err.code };
                                node.status(status)
                                node.error(err, err.message)
                            })
                        } else {
                            nodeContext.set(`${node.mydb}_schema`, null)
                            msg.payload.schema = null
                        }
                    } else {
                        msg.payload.schema = nodeContext.get(`${node.mydb}_schema`)
                    }
                    if (typeof msg.payload.query === 'string') {
                        node.mydbConfig.pool.getConnection(function (err, conn) {
                            if (err) {
                                if (conn) {
                                    conn.release()
                                }
                                status = { fill: "red", shape: "ring", text: RED._("mysql.status.error") + ": " + err.code };
                                node.status(status);
                                node.error(err, msg);
                                if (done) { done(); }
                                return
                            }

                            var bind = [];
                            if (Array.isArray(msg.payload.values)) {
                                bind = msg.payload;
                            }
                            else if (typeof msg.payload.values === 'object' && msg.payload.values !== null) {
                                bind = msg.payload;
                            }
                            conn.config.queryFormat = Array.isArray(msg.payload.values) ? null : customQueryFormat
                            conn.query(msg.payload.query, bind, function (err, rows) {
                                conn.release()
                                if (err) {
                                    status = { fill: "red", shape: "ring", text: RED._("mysql.status.error") + ": " + err.code };
                                    node.status(status);
                                    node.error(err, msg);
                                }
                                else {
                                    msg.payload.result = rows;
                                    
                                    send(msg);
                                    status = { fill: "green", shape: "dot", text: RED._("mysql.status.ok") };
                                    node.status(status);
                                }
                                if (done) { done(); }
                            });
                        })
                    }
                    else {
                        if (typeof msg.payload.query !== 'string') { node.error("msg.payload.query : "+RED._("mysql.errors.notstring")); done(); }
                    }
                }
                else {
                    node.error(RED._("mysql.errors.notconnected"),msg);
                    status = {fill:"red",shape:"ring",text:RED._("mysql.status.notconnected")};
                    if (done) { done(); }
                }
                if (!busy) {
                    busy = true;
                    node.status(status);
                    node.tout = setTimeout(function() { busy = false; node.status(status); },500);
                }
            });

            node.on('close', function() {
                if (node.tout) { clearTimeout(node.tout); }
                node.mydbConfig.removeAllListeners();
                node.status({});
            });
        }
        else {
            this.error(RED._("mysql.errors.notconfigured"));
        }
    }
    RED.nodes.registerType("mysql",MysqlDBNodeIn);
}

function customQueryFormat(query, values) {
    if (!values) {
        return query;
    }
    return query.replace(/\:(\w+)/g, function(txt, key) {
        if (values.hasOwnProperty(key)) {
            return this.escape(values[key]);
        }
        return txt;
    }.bind(this));
}
