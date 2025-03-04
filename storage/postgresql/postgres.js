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
 */
module.exports = function (RED) {
  "use strict";
  var reconnect = RED.settings.mysqlReconnectTime || 20000;
  var Pool = require("pg-pool");
  const pgStructure = require("pg-structure");


  function PostgresSQLNode(n) {
    RED.nodes.createNode(this, n);
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

    // function checkVer() {
    //   node.pool.query("SELECT version();", [], function (err, rows, fields) {
    //     if (err) {
    //       node.error(err);
    //       node.status({
    //         fill: "red",
    //         shape: "ring",
    //         text: RED._("postgres.status.badping"),
    //       });
    //       doConnect();
    //     }
    //   });
    // }

    function doConnect() {
      node.connecting = true;
      node.emit("state", "connecting");
      if (!node.pool) {
        node.pool = new Pool({
          host: node.host,
          port: node.port,
          user: node.credentials.user,
          password: node.credentials.password,
          database: node.dbname,
          max: 20, // set pool max size to 20
          idleTimeoutMillis: 5000, // close idle clients after 1 second
          connectionTimeoutMillis: 1000, // return an error after 1 second if connection could not be established
          maxUses: 7500,
        });
      }

      // connection test
      node.pool.connect(function (err, connection, done) {
        node.connecting = false;
        if (err) {
          node.emit("state", err.code);
          node.error(err);
          node.tick = setTimeout(doConnect, reconnect);
        } else {
          node.connected = true;
          node.emit("state", "connected");
          // if (!node.check) {
          //   node.check = setInterval(checkVer, 290000);
          // }
          connection.release();
        }
      });
    }

    node.connect = function () {
      if (!node.connected && !node.connecting) {
        doConnect();
      }
    };

    node.on("close", function (done) {
      if (node.tick) {
        clearTimeout(node.tick);
      }
      if (node.check) {
        clearInterval(node.check);
      }
      // node.connection.release();
      node.emit("state", " ");
      if (node.connected) {
        node.connected = false;
        node.pool.end(function (err) {
          done();
        });
      } else {
        delete node.pool;
        done();
      }
    });
  }
  RED.nodes.registerType("PostgresSQLDatabase", PostgresSQLNode, {
    credentials: {
      user: { type: "text" },
      password: { type: "password" },
    },
  });

  function PostgresDBNodeIn(n) {
    RED.nodes.createNode(this, n);
    this.mydb = n.mydb;
    this.mydbConfig = RED.nodes.getNode(this.mydb);

    this.query = n.query;
    this.status({});

    const host = this.mydbConfig.host;
    const db = this.mydbConfig.dbname;
    const user = this.mydbConfig.credentials.user;
    const password = this.mydbConfig.credentials.password;
    const port = this.mydbConfig.port;
    const schemaAccess = this.mydbConfig.schemaAccess;

    const nodeContext = this.context();

    if (this.mydbConfig) {
      this.mydbConfig.connect();
      var node = this;
      var busy = false;
      var status = {};
      node.mydbConfig.on("state", function (info) {
        if (info === "connecting") {
          node.status({ fill: "grey", shape: "ring", text: info });
        } else if (info === "connected") {
          node.status({ fill: "green", shape: "dot", text: info });
        } else {
          node.status({ fill: "red", shape: "ring", text: info });
        }
      });

      async function getDDLScripts() {
        try {
          const dbase = await pgStructure.default(
            {
              database: db,
              user: user,
              password: password,
              host: host,
              port: port,
            },
            { includeSchemas: ["public"] }
          );

          const tables = dbase.tables;
          let DDL = ""
          for (const table of tables) {
            DDL = DDL + `DDL script for table: ${table.name}\n`
            DDL = DDL + generateCreateTableScript(table) +"\n"
            DDL = DDL + generateIndexesScript(table) + "\n";
            DDL = DDL + generateForeignKeysScript(table) + "\n";
            DDL = DDL + "-------------------------------------------------------------------\n\n"
            console.log("");
          }
          return DDL;
        } catch (error) {
          console.error("Error:", error);
        }
      }

      function generateCreateTableScript(table) {
        const columnsDDL = table.columns
          .map((column) => {
            const dataType = column.type.name;
            const notNull = column.notNull ? "NOT NULL" : "";
            const defaultValue = column.default
              ? `DEFAULT ${column.default}`
              : "";
            return `  ${column.name} ${dataType} ${notNull} ${defaultValue}`;
          })
          .join(",\n");

        const primaryKey = table.primaryKey
          ? `, PRIMARY KEY (${table.primaryKey.columns
              .map((col) => col.name)
              .join(", ")})`
          : "";

        const ddl = `CREATE TABLE ${table.name} (\n${columnsDDL}${primaryKey}\n);`;

        return ddl;
      }

      function generateIndexesScript(table) {
        const indexesDDL = table.indexes
          .map((index) => {
            const unique = index.isUnique ? "UNIQUE" : "";
            const columnNames = index.columns.map((col) => col.name).join(", ");
            return `CREATE ${unique} INDEX ${index.name} ON ${table.name} (${columnNames});`;
          })
          .join("\n");

        return indexesDDL;
      }

      function generateForeignKeysScript(table) {
        const foreignKeysDDL = table.foreignKeys
          .map((fk) => {
            const columnNames = fk.columns.map((col) => col.name).join(", ");
            const refTable = fk.referencedTable;
            const refColumnNames = fk.referencedColumns
              .map((col) => col.name)
              .join(", ");
            return `ALTER TABLE ${table.name} ADD CONSTRAINT ${fk.name} FOREIGN KEY (${columnNames}) REFERENCES ${refTable.name} (${refColumnNames});`;
          })
          .join("\n");

        return foreignKeysDDL;
      }

      if (schemaAccess) {
        getDDLScripts()
          .then((result) => {
            nodeContext.set(
              `${this.mydb}_schema`,
              "DATABASE NAME: " + db + "\n\n" + result
            );
          })
          .catch((err) => {
            status = {
              fill: "red",
              shape: "ring",
              text: RED._("postgres.status.error") + ": " + err.code,
            };
            this.status(status);
            this.error(err, err.message);
          });
      } else {
        nodeContext.set(`${this.mydb}_schema`, null);
      }

      node.on("input", function (msg, send, done) {
        if (this.query !== "payload.query") {
          msg.payload.query = this.query;
        }
        if (node.mydbConfig.connected) {
          if (
            !nodeContext.get(`${node.mydb}_schema`) &&
            msg?.payload?.renewSchema &&
            typeof msg?.payload?.renewSchema === "boolean"
          ) {
            if (schemaAccess) {
              getDDLScripts()
                .then((result) => {
                  nodeContext.set(
                    `${node.mydb}_schema`,
                    "DATABASE NAME: " + db + "\n\n" + result
                  );
                  msg.payload.schema = result;
                })
                .catch((err) => {
                  status = {
                    fill: "red",
                    shape: "ring",
                    text: RED._("postgres.status.error") + ": " + err.code,
                  };
                  node.status(status);
                  node.error(err, err.message);
                });
            } else {
              nodeContext.set(`${node.mydb}_schema`, null);
              msg.payload.schema = null;
            }
          } else {
            if(schemaAccess){
              getDDLScripts()
                .then((result) => {
                  nodeContext.set(
                    `${node.mydb}_schema`,
                    "DATABASE NAME: " + db + "\n\n" + result
                  );
                  msg.payload.schema = result;
                })
                .catch((err) => {
                  status = {
                    fill: "red",
                    shape: "ring",
                    text: RED._("postgres.status.error") + ": " + err.code,
                  };
                  node.status(status);
                  node.error(err, err.message);
                });
            } else {
              msg.payload.schema = nodeContext.get(`${node.mydb}_schema`);
            }
          }
          send =
            send ||
            function () {
              node.send.apply(node, arguments);
            };
          if (!msg.payload.query) {
            node.send(msg);
          } else if (typeof msg.payload.query === "string") {
            node.mydbConfig.pool.connect(function (err, conn) {
              if (err) {
                if (conn) {
                  conn.release();
                }
                status = {
                  fill: "red",
                  shape: "ring",
                  text: RED._("postgres.status.error") + ": " + err.code,
                };
                node.status(status);
                node.error(err, msg);
                if (done) {
                  done();
                }
                return;
              }

              var bind = [];
              if (Array.isArray(msg.payload.values)) {
                bind = msg.payload;
              } else if (
                typeof msg.payload.values === "object" &&
                msg.payload.values !== null
              ) {
                bind = msg.payload;
              }
            //   conn.config.queryFormat = Array.isArray(msg.payload.values)
            //     ? null
            //     : customQueryFormat;
              conn.query(msg.payload.query, bind, function (err, result) {
                conn.release();
                if (err) {
                  status = {
                    fill: "red",
                    shape: "ring",
                    text: RED._("postgres.status.error") + ": " + err.code,
                  };
                  node.status(status);
                  node.error(err, msg);
                } else {
                  msg.payload.result = result.rows;
                  send(msg);
                  status = {
                    fill: "green",
                    shape: "dot",
                    text: RED._("postgres.status.ok"),
                  };
                  node.status(status);
                }
                if (done) {
                  done();
                }
              });
            });
          } else {
            if (typeof msg.payload.query !== "string") {
              node.error(
                "msg.payload.query : " + RED._("postgres.errors.notstring")
              );
              done();
            }
          }
        } else {
          node.error(RED._("postgres.errors.notconnected"), msg);
          status = {
            fill: "red",
            shape: "ring",
            text: RED._("postgres.status.notconnected"),
          };
          if (done) {
            done();
          }
        }
        if (!busy) {
          busy = true;
          node.status(status);
          node.tout = setTimeout(function () {
            busy = false;
            node.status(status);
          }, 500);
        }
      });

      node.on("close", function () {
        if (node.tout) {
          clearTimeout(node.tout);
        }
        node.mydbConfig.removeAllListeners();
        node.status({});
      });
    } else {
      this.error(RED._("postgres.errors.notconfigured"));
    }
  }
  RED.nodes.registerType("postgresql", PostgresDBNodeIn);
};

function customQueryFormat(query, values) {
  if (!values) {
    return query;
  }
  return query.replace(
    /\:(\w+)/g,
    function (txt, key) {
      if (values.hasOwnProperty(key)) {
        return this.escape(values[key]);
      }
      return txt;
    }.bind(this)
  );
}
