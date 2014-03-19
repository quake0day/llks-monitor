module.exports = {};

module.exports.start = function() {
  this.loop(30000);
};

module.exports.loop = function(wait) {
  var self = this;
  var now = new Date;
  var hour = now.getHours();
  var minute = now.getMinutes();
  var promise;

  // 17:00 ~ 17:30
  if (hour === 17 && minute <= 30) {
    promise = self.getHttpData('/index.php/transaction/' +
      'get_market_overview_day/180');
  } else {
    var deferred = self.Q.defer();
    deferred.resolve();
    promise = deferred.promise;
  }

  promise = promise.then(function(data) {
    if (!data) return;

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
    self.db.market.update({
      name: 'market-overiew-180'
    }, {
      name: 'market-overiew-180',
      data: JSON.stringify(H)
    }, {
      upsert: true
    });
  });

  promise.finally(function() {
    var timeout = setTimeout(function() {
      self.loop(wait);
    }, wait);

    self.reset().add(+(new Date), timeout);
  });
};
