var Query = require('./query').Query,
    Result = require('./result').Result;

var thrift = require('thrift'),
    ttransport = require('thrift/transport'),
    ThriftHive = require('gen-nodejs/ThriftHive');

var kyotoclient = require('kyoto-client');

var KT_SHIB_DEFAULT = "shib.kch",
    KT_SHIB_RESULT = "result.kcd";

var HISTORY_KEY_PREFIX = "history:",
    KEYWORD_KEY_PREFIX = "keyword:",
    QUERY_KEY_PREFIX = "query:",
    RESULT_KEY_PREFIX = "result:";

var STATUS_LABEL_WAITING = "waiting",
    STATUS_LABEL_RUNNING = "running",
    STATUS_LABEL_DONE = "done",
    STATUS_LABEL_RERUNNING = "rerunning";

var HIVESERVER_READ_LINES = 100;

var LocalStoreError = exports.LocalStoreError = function(msg){
  this.name = 'LocalStoreError';
  Error.call(this, msg);
  Error.captureStackTrace(this, arguments.callee);
};
LocalStoreError.prototype.__proto__ = Error.prototype;

var Client = exports.Client = function(args){
  this.conf = args;

  this.hiveconnection = undefined;
  this.hiveclient = undefined;
  this.kyotoclient = undefined;
};

Client.prototype.hiveClient = function(){
  if (this.hiveconnection && this.hiveclient) {
    return this.hiveclient;
  }
  this.hiveconnection = thrift.createConnection(
    this.conf.hiveserver.host,
    this.conf.hiveserver.port,
    {transport: ttransport.TBufferedTransport}
  );
  this.hiveclient = thrift.createClient(ThriftHive, this.hiveconnection);
  return this.hiveclient;
};

Client.prototype.kyotoClient = function(){
  if (this.kyotoclient) {
    return this.kyotoclient;
  }
  this.kyotoclient = new kyotoclient.Db(this.conf.kyototycoon.host, this.conf.kyototycoon.port);
  this.kyotoclient.open();
  return this.kyotoclient;
};

Client.prototype.end = function(){
  if (this.hiveconnection) {
    this.hiveconnection.end();
    this.hiveconnection = this.hiveclient = undefined;
  }
  if (this.kyotoclient) {
    this.kyotoclient.close();
    this.kyotoclient = undefined;
  }
};

var encodeIdList = function(str){return new Buffer(str, 'ascii');};
var decodeIdList = function(buf){return buf && buf.toString('ascii');};
var encodeObject = function(str){return new Buffer(str, 'utf8');};
var decodeObject = function(buf){return buf && buf.toString('utf8');};

var pad = function(n){return n < 10 ? '0'+n : n;};
var historyKey = function(){
  var d = new Date();
  return '' + d.getFullYear() + pad(d.getMonth());
};

Client.prototype.getKeys = function(type, callback){
  var client = this;
  this.kyotoClient().matchPrefix(type, KT_SHIB_DEFAULT, function(err, data){
    callback.apply(client, [err, data.map(function(v){return v.substr(type.length);})]);
  });
};

Client.prototype.getIds = function(type, key, callback){
  var client = this;
  this.kyotoClient().get(type + key, KT_SHIB_DEFAULT, function(err, data){
    if (err || data == null)
      callback.apply(client, [err, []]);
    else
      callback.apply(client, [err, decodeIdList(data).substr(1).split(',')]);
  });
};

Client.prototype.addId = function(type, key, id, callback){
  var client = this;
  this.kyotoClient().append(type + key, encodeIdList(',' + id), KT_SHIB_DEFAULT, function(err){
    if (callback)
      callback.apply(client, [err]);
  });
};

Client.prototype.getObject = function(type, key, callback){
  var client = this;
  this.kyotoClient().get(type + key, KT_SHIB_DEFAULT, function(err, data){
    if (err || data == null)
      callback.apply(client, [err, null]);
    else
      callback.apply(client, [err, decodeObject(data)]);
  });
};

Client.prototype.getObjects = function(type, keys, callback){
  var client = this;
  var objkeys = keys.map(function(v){return type + v;});
  this.kyotoClient().getBulk(objkeys, KT_SHIB_DEFAULT, function(err, data){
    if (err)
      callback.apply(client, [err, null]);
    else
      callback.apply(client, [err, objkeys.map(function(k){return decodeObject(data[k]);})]);
  });
};

Client.prototype.setObject = function(type, key, obj, callback){
  var client = this;
  this.kyotoClient().set(type + key, encodeObject(obj), KT_SHIB_DEFAULT, function(err){
    if (callback)
      callback.apply(client, [err]);
  });
};

Client.prototype.getHistory = function(yyyymm, callback){
  this.getIds(HISTORY_KEY_PREFIX, yyyymm, callback);
};
Client.prototype.history = Client.prototype.getHistory;
  
Client.prototype.getHistories = function(callback){
  this.getKeys(HISTORY_KEY_PREFIX, callback);
};
Client.prototype.histories = Client.prototype.getHistories;

Client.prototype.addHistory = function(query){
  this.addId(HISTORY_KEY_PREFIX, historyKey(), query.queryid);
};

Client.prototype.getKeyword = function(keyword, callback){
  this.getIds(KEYWORD_KEY_PREFIX, keyword, callback);
};
Client.prototype.keyword = Client.prototype.getKeyword;

Client.prototype.getKeywords = function(callback){
  this.getKeys(KEYWORD_KEY_PREFIX, callback);
};
Client.prototype.keywords = Client.prototype.getKeywords;

Client.prototype.addKeyword = function(query){
  if (query.keywords.length < 1)
    return;
  this.addId(KEYWORD_KEY_PREFIX, query.keywords[0], query.queryid);
};

Client.prototype.getQuery = function(queryid, callback){
  var client = this;
  this.getObject(QUERY_KEY_PREFIX, queryid, function(err, data){
    if (err || data == null)
      callback.apply(client, [err, null]);
    else
      callback.apply(client, [err, new Query({json:data})]);
  });
};
Client.prototype.query = Client.prototype.getQuery;

Client.prototype.updateQuery = function(query, callback) {
  var client = this;
  this.setObject(QUERY_KEY_PREFIX, query.queryid, query.serialized(), function(err){
    if (callback)
      callback.apply(client, [err]);
  });
};

Client.prototype.createQuery = function(querystring, keywordlist, callback){
  var client = this;
  try {
    var query = new Query({querystring:querystring, keywords:keywordlist});
    this.setObject(QUERY_KEY_PREFIX, query.queryid, query.serialized(), function(err){
      if (callback)
        callback.apply(client, [err, query]);
    });
  }
  catch (e) {
    if (callback)
      callback.apply(client, [e]);
  }
};

Client.prototype.getResult = function(resultid, callback){
  var client = this;
  this.getObject(RESULT_KEY_PREFIX, resultid, function(err, data){
    if (err || data == null)
      callback.apply(client, [err, null]);
    else
      callback.apply(client, [err, new Result({json:data})]);
  });
};
Client.prototype.result = Client.prototype.getResult;

Client.prototype.getResults = function(resultids, callback){
  var client = this;
  this.getObjects(RESULT_KEY_PREFIX, resultids, function(err, data){
    if (err)
      callback.apply(client, [err, []]);
    else
      callback.apply(client, [err, data.map(function(v){return v && new Result({json:v});})]);
  });
};

Client.prototype.setResult = function(result, callback){
  var client = this;
  this.setObject(RESULT_KEY_PREFIX, result.resultid, result.serialized(), function(err){
    if (callback)
      callback.apply(client, [err]);
  });
};

Client.prototype.getResultData = function(resultid, callback){
  var client = this;
  this.getRawResultData(resultid, function(err, data){
    if (err || data == null){
      callback.apply(client, [err, null]);
      return;
    }

    var list = [];
    data.split("\n").forEach(function(line){
      if (line == "")
        return;
      list.push(line.split("\t"));
    });
    callback.apply(client, [err, list]);
  });
};
Client.prototype.resultData = Client.prototype.getResultData;

Client.prototype.getRawResultData = function(resultid, callback){
  this.kyotoClient().get(resultid, KT_SHIB_RESULT, function(err, data){
    callback.apply(this, [err, decodeObject(data)]);
  });
};
Client.prototype.rawResultData = Client.prototype.getRawResultData;

Client.prototype.appendResultData = function(resultid, data, callback){
  var client = this;
  this.kyotoClient().append(resultid, encodeObject(data.join("\n") + "\n"), KT_SHIB_RESULT, function(err){
    callback.apply(client, [err]);
  });
};

Client.prototype.refresh = function(query){
  this.execute(query, true);
};

Client.prototype.getLastResult = function(query, callback){
  var client = this;
  if (query.results.length < 1){
    callback.apply(client, [undefined, null]);
    return;
  }
  this.getResults(query.results.reverse().map(function(v){return v.resultid;}), function(err, results){
    if (err){
      callback.apply(client, [err, undefined]);
      return;
    }
    var r;
    while((r = results.shift()) !== undefined){
      if (r.running())
        continue;
      callback.apply(client, [undefined, r]);
      return;
    }
    callback.apply(client, [undefined, null]);
  });
};

Client.prototype.status = function(query, callback){
  var client = this;
  /*
   callback argument
   running: newest-and-only query running, and result not stored yet.
   done: newest query executed, and result stored.
   error: newest query executed, but done with error.
   cached: newest query running, but older result exists.
   waiting: query created, but not executed.
   */
  if (query.results.length < 1) {
    callback.apply(client, ["waiting"]);
    return;
  }
  var resultid_revs = query.results.reverse().map(function(v){return v.resultid;});
  this.getResults(resultid_revs, function(err, results){
    if (! results.every(function(element, index, array){return element !== null && element !== undefined;}))
      throw new LocalStoreError("Result is null for one or more ids of: " + resultid_revs.join(","));

    var newest = results.shift();
    if (newest.running()){
      if (results.length < 1)
        callback.apply(client, ["running"]);
      else {
        var alter = results.shift();
        if (! alter.running() && ! alter.withError())
          callback.apply(client, ["cached"]);
        else
          callback.apply(client, ["running"]);
      }
    }
    else if (newest.withError())
      callback.apply(client, ["error"]);
    else
      callback.apply(client, ["done"]);
  });
};

Client.prototype.execute = function(query, refreshed){
  if (! refreshed) {
    this.addHistory(query);
    this.addKeyword(query);
  }

  var client = this;

  var executed_at = (new Date()).toLocaleString();
  var result = new Result({queryid:query.queryid, executed_at:executed_at});
  this.setResult(result, function(){
    query.results.push({executed_at:executed_at, resultid:result.resultid});
    this.updateQuery(query);
  
    client.hiveClient().execute(query.composed(), function(err, data){
      var resultkey = result.resultid;
      var onerror = null;

      var resultfetch = function(callback) {
        client.hiveClient().fetchN(HIVESERVER_READ_LINES, function(err, data){
          if (err){
            onerror = err;
            return;
          }
          if (data.length == 1 && data[0].length < 1){
            callback.apply(client, []);
            return;
          }
          client.appendResultData(resultkey, data, function(err){
            if (err)
              throw new LocalStoreError("failed to append result data to KT");
            resultfetch(callback);
          });
        });
      };
      client.hiveClient().getSchema(function(err, data){
        if (err){
          onerror = err;
          return;
        }
        result.schema = data.fieldSchemas;
        resultfetch(function(){
          result.markAsExecuted(onerror);
          client.setResult(result);
        });
      });
    });
  });
};