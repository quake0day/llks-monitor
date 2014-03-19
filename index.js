var express = require('express');
var db = require('./db');

var app = express();

app.set('port', process.env.PORT || 3000);

app.configure('development', function() {
  app.use(express.static(__dirname + '/assets'));
});

app.use(express.bodyParser());
app.use(express.static(__dirname + '/public'));

var I18N = require('./translations');

app.use(function(req, res, next) {
  req.userLang = null;
  if (req.headers) {
    req.userLang = req.headers['x-user-lang'];
  }
  req.$$ = function(string) {
    string = string.trim().replace(/[\n\s]{1,}/g, ' ');
    var code = req.userLang;
    var lang = I18N[code] || {};
    var text = string.slice(string.lastIndexOf(':') + 1) || string;
    return lang[string] || text;
  };
  next();
});

app.post('/login', function(req, res, next) {
  db.authenticate(req.body.username, req.body.password, null,
    function(code, user) {
    switch (code) {
    case db.authConst.INVALID:
      res.status(401);
      res.send({ error: req.$$('Invalid username or password.') });
      return;
    case db.authConst.LOCKED:
      res.writeHead(466, 'User Is Banned');
      res.end(JSON.stringify({ error: req.$$('The account is temporarily ' +
        'locked due to too many failed login attempts.') }));
      return;
    case db.authConst.BANNED:
      res.writeHead(466, 'User Is Banned');
      res.end(JSON.stringify({
        error: req.$$('You are banned by administrators.')
      }));
      return;
    case db.authConst.SUCCESS:
      res.status(200);
      res.send({
        id: user._id,
        username: user.username,
        token: user.token
      });

      try {
        var clients = io.sockets.clients();
        for (var i = 0; i < clients.length; i++) {
          var user_id = clients[i].handshake.user_id;
          if (user._id === user_id) {
            clients[i].disconnect();
          }
        }
      } catch(e) {}
      return;
    default:
      res.writeHead(499, 'Unknown Error');
      res.end(JSON.stringify({ error: req.$$('Unknown Error.') }));
      return;
    }
  });
});

app.use(function(req, res, next) {
  req._user_id = null;
  req._user_token = null;
  if (req.headers) {
    req._user_id = req.headers['x-user-id'];
    req._user_token = req.headers['x-user-token'];
  }
  next();
});

function serverError(req, res) {
  res.status(500);
  res.send({ error: req.$$('Server error.') });
}

function permissionDenied(req, res) {
  res.status(403);
  res.send({ error: req.$$('Permission denied.') });
}

function authorize(callback) {
  return function(req, res, next) {
    var user = db.users.findOne({
      _id: req.headers['x-user-id'],
      token: req.headers['x-user-token']
    }).exec(function(error, user) {
      if (error || !user) return permissionDenied(req, res);
      req.user = user;
      callback(req, res, next);
    });
  };
}

app.get('/my', authorize(function(req, res, next) {
  db.users.findOne({ _id: req.user._id }, function(err, user) {
    if (err) return next();
    var llia = user.last_logged_in_at || [];
    llia = llia.map(function(l) {
      return +l;
    });
    res.status(200);
    res.send({
      _id: user._id,
      username: user.username,
      created_at: +user.created_at,
      updated_at: +user.updated_at,
      last_logged_in_at: llia,
      password_updated_at: +user.password_updated_at
    });
  });
}));

app.put('/my', authorize(function(req, res, next) {
  var oldPassword = req.body.oldpassword;
  var newPassword = req.body.newpassword;
  if (!db.checkPassword(oldPassword) || !db.checkPassword(newPassword)) {
    return next();
  }
  db.authenticate(req.user.username, oldPassword, { dry: true },
    function(code, user) {
    if (code !== db.authConst.SUCCESS) return next();
    var new_date = new Date;
    db.users.update({
      _id: user._id
    }, { $set: {
      password: db.hashPassword(newPassword),
      password_updated_at: new_date,
      updated_at: new_date
    } }, {}, function(err) {
      if (err) return next();
      res.status(200);
      res.send({ status: req.$$('OK') });
    });
  });
}));

app.post('/accounts', authorize(function(req, res, next) {
  var name = req.body.name;
  var code = req.body.code;
  if (!name || !code) return next();
  var user = req.user;
  db.createAccount(name, code, user, function(err, account) {
    if (err) return serverError(req, res);
    onAccountChanges();
    res.status(201);
    res.send(account);
  });
}));

app.put('/accounts/:account_id', authorize(function(req, res, next) {
  var data = req.body;
  if (!data) return next();
  db.accounts.findOne({ _id: req.params.account_id }, function(err, account) {
    if (err || !account) return next();
    var set = {};
    if (data.hasOwnProperty('code')) {
      if (!data.code) return next();
      set.code = data.code;
    }
    if (data.hasOwnProperty('name')) {
      if (!data.name) return next();
      set.name = data.name;
    }
    if (Object.keys(set).length === 0) return next();
    set.updated_at = new Date;
    db.accounts.update({ _id: account._id }, { $set: set }, {}, function(err) {
      if (err) return serverError(req, res);
      onAccountChanges();
      res.status(200);
      res.send({ status: req.$$('OK') });
    });
  });
}));

app.delete('/accounts/:account_id', authorize(function(req, res, next) {
  db.accounts.remove({ _id: req.params.account_id }, {}, function(err) {
    if (err) return serverError(req, res);
    onAccountChanges();
    res.status(200);
    res.send({ status: req.$$('OK') });
  });
}));

function onAccountChanges() {
  HereAreTheAccounts();
  minerMonitor.restart();
}

var server = require('http').createServer(app);

server.listen(app.get('port'), function(){
  console.log('Express server listening on port ' + app.get('port'));
});

var https = require('https');
var io = require('socket.io').listen(server);

app.configure('production', function() {
  io.disable('browser client');
});

io.configure(function() {
  io.set('authorization', function(handshakeData, callback) {
    var id = handshakeData.query.id;
    var token = handshakeData.query.token;
    if (id && token) {
      db.users.findOne({
        _id: id,
        token: token
      }).exec(function(error, user) {
        if (error) return callback('Error occurred.', false);
        if (!user) return callback(null, false);
        handshakeData.user_id = user._id;
        return callback(null, true);
      });
      return;
    }
    callback('Please provide user id and token!', false);
  });
  io.set('log level', 1);
  // 0 - error
  // 1 - warn
  // 2 - info
  // 3 - debug
});

var Q = require('q');

function getHttpData(location, code) {
  var deferred = Q.defer();
  var request = https.get({
    hostname: 'jiaoyi.yunfan.com',
    port: 443,
    path: location,
    headers: code ? {
      Cookie: 'ntts_kb_session_id=' + code + ';'
    } : undefined
  }, function (res) {
    var data = '';
    res.on('data', function(chunk) {
      data += chunk;
    });
    res.on('end', function() {
      deferred.resolve(data);
    });
  });
  request.on('error', function(error) {
    deferred.reject(error);
  });
  request.setTimeout(3000, function() {
    request.abort();
    deferred.reject('timeout');
  });
  return deferred.promise;
}

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function HereAreTheAccounts() {
  var self = this;
  if (typeof self.emit !== 'function') self = io.sockets;
  db.accounts.find({}, function(err, accounts) {
    if (err) return;
    accounts.map(function(account) {
      delete account.code;
    });
    self.emit('HereAreTheAccounts', accounts);
  });
}

function HereAreTheHistoryData(length) {
  var self = this;
  if (typeof self.emit !== 'function') self = io.sockets;

  var length;
  if (length === 14) length = 14;
  if (length === 30) length = 30;
  if (length === 60) length = 60;
  if (!length) length = 7;

  getHttpData('/index.php/transaction/get_market_overview_day/' + length).
  then(function(data) {
    try {
      data = JSON.parse(data);
      var H = [];
      for (var i = 0; i < data.data.length; i++) {
        var d = data.data[i];
        var n = data.data[i-1];
        H.push({
          date: +new Date(d.createtime),
          price: (+d.price).toFixed(2),
          _price: n ? (+n.price).toFixed(2) : null,
          volume: +d.mineral,
          _volume: n ? +n.mineral : null
        });
      }
      self.emit('HereAreTheHistoryData', H);
    } catch(e) {}
  });
}

var assetsHashes = {};

try {
  assetsHashes = require('./db/.assets.json');
} catch(e) {
  console.log('db/.assets.json not found');
}

io.sockets.on('connection', function(socket) {
  socket.emit('ServerHasUpdated', assetsHashes);
  socket.on('GiveMeAccounts', HereAreTheAccounts);
  socket.on('GiveMeHistoryData', HereAreTheHistoryData);
});

process.on('SIGINT', function() {
  for (var s in io.sockets.sockets) {
    io.sockets.sockets[s].disconnect();
  }
  process.exit(0);
});


function Monitor(startFunction, loopFunction) {

  var timeouts = {};

  this.start = function() {};
  if (typeof startFunction === 'function') {
    this.start = startFunction;
  }

  this.loop = function() {};
  if (typeof loopFunction === 'function') {
    this.loop = loopFunction;
  }

  this.stop = function() {
    for (var timeout in timeouts) {
      clearTimeout(timeouts[timeout]);
    }
    timeouts = {};
  };

  this.restart = function() {
    this.stop.call(this);
    this.start.call(this);
  };

  this.add = function(key, timeout) {
    timeouts[key] = timeout;
  };

}

// Get miners every 5 seconds

var startFunction = function() {
  var self = this;
  db.accounts.find({}, function(err, accounts) {
    if (err) return;
    for (var i = 0; i < accounts.length; i++) {
      var account = accounts[i];
      self.loop(account, getRandomInt(0, 5000));
    }
  });
};

var loopFunction = function(account, wait) {
  var self = this;
  var code = account.code;

  getHttpData('/dig/miner/log/', code).

  then(function(data) {
    data = JSON.parse(data);
    if (!data.data.stats) return { error: 'expired' };
    var miners = [];
    for (var i = 0; i < data.data.stats.length; i++) {
      var miner = data.data.stats[i];
      miners.push({
        ip: miner.ip,
        speed: miner.speed,
        total: +miner.total_mineral,
        today: +miner.today_mineral,
        yesterday: +miner.yes_mineral,
        servertime: +new Date(miner.update_time),
        status: miner.status
      });
    }
    return {
      updated: +new Date,
      miners: miners
    };
  }).

  then(function(data) {
    var bundle = {};
    bundle[account._id] = data;
    db.accounts.update({ _id: account._id }, { $set: {
      data: JSON.stringify(bundle)
    } }, {}, function() {
      db.accounts.persistence.compactDatafile();
    });
    io.sockets.emit('UpdateMiners', bundle);
  }).

  then(function() {
    return getHttpData('/index.php/transaction/get_current_price');
  }).

  then(function(data) {
    try {
      var marketData = JSON.parse(data);
      var bundle = {};
      bundle[account._id] = {
        price: +marketData.data.price
      };
      db.accounts.update({ _id: account._id }, { $set: bundle[account._id] });
      io.sockets.emit('updateAccount', bundle);
    } catch(e) {}
  }).

  then(function(data) {
    return getHttpData('/dig/miner/stats/', code);
  }).

  then(function(data) {
    try {
      var accountData = JSON.parse(data);
      var bundle = {};
      bundle[account._id] = {
        total: +accountData.data.total_flow,
        unsold: +accountData.data.flow,
        sold: +accountData.data.sold
      };
      db.accounts.update({ _id: account._id }, { $set: bundle[account._id] });
      io.sockets.emit('updateAccount', bundle);
    } catch(e) {}
  }).

  finally(function() {
    var timeout = setTimeout(function() {
      self.loop(account);
    }, wait || 5000);
    minerMonitor.add(account._id, timeout);
  });
}

var minerMonitor = new Monitor(startFunction, loopFunction);

minerMonitor.start();
