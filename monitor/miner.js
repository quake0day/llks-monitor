module.exports = {};

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports.start = function() {
  var self = this;
  self.db.accounts.find({}, function(err, accounts) {
    if (err) return;
    for (var i = 0; i < accounts.length; i++) {
      var account = accounts[i];
      self.loop(account, getRandomInt(0, 5000));
    }
  });
};

module.exports.loop = function(account, wait) {
  var self = this;
  var code = account.code;
  var DATA;

  self.Q.

  fcall(function() {
    DATA = null;
  }).

  then(function(data) {
    return self.getHttpData('/dig/miner/log/', code);
  }).

  then(function(data) {
    data = JSON.parse(data);
    if (!data.data.stats) return { error: 'expired' };
    var miners = [];
    // first item is the sum of others
    for (var i = 1; i < data.data.stats.length; i++) {
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
    DATA = {
      updated: +new Date,
      miners: miners
    };
    return DATA;
  }).

  then(function(data) {
    var bundle = {};
    bundle[account._id] = data;
    self.db.accounts.update({ _id: account._id }, { $set: {
      data: JSON.stringify(bundle)
    } }, {}, function() {
      self.db.accounts.persistence.compactDatafile();
    });
    return bundle;
  }).

  then(function(bundle) {
    var clients = self.io.of('/private').clients();
    return clients.reduce(function(prev, cur) {
      return prev.then(function() {
        var handshake = cur.manager.handshaken[cur.id];
        var subscriptions;
        try {
          subscriptions = JSON.parse(handshake.user.subscriptions) || [];
        } catch(e) {
          subscriptions = [];
        }
        if (subscriptions.indexOf(account._id) !== -1) {
          cur.emit('UpdateMiners', bundle);
        }
      });
    }, self.Q());
  }).

  then(function() {
    return self.Q.all([
      self.getHttpData('/index.php/transaction/get_current_price'),
      self.getHttpData('/dig/stats/', code)
    ]);
  }).

  then(function(data) {
    var priceData = JSON.parse(data[0]) || {};
    if (!priceData.ok) return;
    var price = +priceData.data.price;
    if (DATA) DATA.price = price;
    if (!data[1]) return;
    var time = priceData.data.createtime.replace(/[^0-9\s\:]+/g, '-');
    time = time.replace('- ', ' ');
    time = +new Date(time);
    var mineralData = JSON.parse(data[1]) || {};
    if (!mineralData.ok) return;
    var bundle = {
      time: time,
      price: {
        current: price,
        diff: +priceData.data.change,
        buy: +priceData.data.buy,
        sell: +priceData.data.sell,
        high: +priceData.data.maxprice,
        low: +priceData.data.minprice
      },
      bought: +priceData.data.buymineral,
      sold: +priceData.data.sellmineral,
      volume: +priceData.data.volume,
      difficulty: parseFloat(mineralData.data.factor),
      miners: +mineralData.data.latest.miner_count,
      today: +(+mineralData.data.latest.today).toFixed(2),
      completed: +mineralData.data.latest.total_mineral,
      completedPercent: mineralData.data.latest.total_per + '%',
    };
    return self.Q().
    then(function() {
      var deferred = self.Q.defer();
      self.db.accounts.update({ _id: account._id }, {
        $set: { price: price }
      }, {}, function(err) {
        if (err) {
          deferred.reject(err);
        } else {
          deferred.resolve();
        }
      });
      return deferred.promise;
    }).
    then(function() {
      var deferred = self.Q.defer();
      self.db.marketHistory.update({ name: 'market-stat' }, {
        name: 'market-stat',
        data: JSON.stringify(bundle)
      }, { upsert: true }, function(err) {
        if (err) {
          deferred.reject(err);
        } else {
          deferred.resolve();
        }
      });
      return deferred.promise;
    }).
    finally(function() {
      self.io.of('/public').emit('UpdateMarket', bundle);
    });
  }).

  catch(function(e) {
    console.error(new Date, '[miner]', e);
  }).

  then(function(data) {
    return self.Q.all([
      self.getHttpData('/dig/miner/stats/', code),
      self.getHttpData('/pay/kuaibi/balance/', code)
    ]);
  }).

  then(function(data) {
    var accountData;
    var balance;
    try {
      accountData = JSON.parse(data[0]);
      balance = JSON.parse(data[1]);
    } catch(e) {
      return;
    }

    var unsold = +accountData.data.flow;
    var totalValue = +(+balance.data.total_amount +
        DATA.price * Math.floor(unsold)).toFixed(2);

    var bundle = {};
    bundle[account._id] = {
      total: +(+accountData.data.total_flow).toFixed(2),
      unsold: +unsold.toFixed(2),
      sold: +(+accountData.data.sold).toFixed(2),
      totalValue: totalValue
    };

    if (DATA) DATA.unsold = unsold;
    var deferred = self.Q.defer();
    self.db.accounts.update({
      _id: account._id
    }, {
      $set: bundle[account._id]
    }, {}, function(err) {
      if (err) {
        deferred.reject(err);
      } else {
        deferred.resolve(bundle);
      }
    });
    return deferred.promise;
  }).

  then(function(bundle) {
    var clients = self.io.of('/private').clients();
    return clients.reduce(function(prev, cur) {
      return prev.then(function() {
        var handshake = cur.manager.handshaken[cur.id];
        var subscriptions;
        try {
          subscriptions = JSON.parse(handshake.user.subscriptions) || [];
        } catch(e) {
          subscriptions = [];
        }
        if (subscriptions.indexOf(account._id) !== -1) {
          cur.emit('UpdateAccounts', bundle);
        }
      });
    }, self.Q());
  }).

  catch(function(e) {
    console.error(new Date, '[miner-stats]', e);
  }).

  then(function() {
    var miners = [];
    if (!DATA || !DATA.miners) {
      return;
    }
    DATA.miners.forEach(function(miner) {
      var times = miner.speed.indexOf('M/S') !== -1 ? 1024 : 1;
      var speed = parseFloat(miner.speed);
      if (isNaN(speed)) speed = 0;
      miners.push([
        miner.servertime / 1000,
        account.name,
        miner.ip,
        speed * times,
        miner.yesterday,
        miner.today,
        miner.total,
        miner.status
      ]);
    });
    var check = self.Q();
    // var check = self.Q().then(function() {
    //   var deferred = self.Q.defer();
    //   self.db.minerStat.count({}, function(err, count) {
    //     if (err) return deferred.reject(err);
    //     if (count > 30000) {
    //       return deferred.reject('too many documents! aborted!');
    //     }
    //     deferred.resolve();
    //   });
    //   return deferred.promise;
    // });
    var updated = Math.floor(DATA.updated / 1000);
    return miners.reduce(function(prev, cur) {
      return prev.then(function() {
        var deferred = self.Q.defer();
        self.db.minerStat.update({
          time: cur[0],
          ip: cur[2]
        }, {
          time: cur[0],
          ip: cur[2],
          updated: updated,
          data: cur
        }, { upsert: true }, function() {
          deferred.resolve();
        });
        return deferred.promise;
      });
    }, check).
    then(function() {
      self.db.minerStat.persistence.compactDatafile();
    }).
    catch(function(err) {
      console.error('miner-stat:', err);
    });
  }).

  catch(function(e) {
    console.error(new Date, '[miner-final]', e);
  }).

  finally(function() {
    var timeout = setTimeout(function() {
      self.loop(account);
    }, wait || self.configs['miner-update-interval'] || 5000);
    self.add(account._id, timeout);
  });
};
