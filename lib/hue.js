var crypto = require('crypto'),
    util = require('util'),
    path = require('./paths'),
    http = require('./http'),
    light = require('./light'),
    group = require('./group'),
    exports = module.exports = new (require("events").EventEmitter)();

var _bridge = null;  
var _host = null;  
var _key = null;  

// ensures we're connectign before calling the callback
function withConnection(callback) {
    if (_bridge) return callback && callback(null, _bridge);
    http.jsonGet(_host, path.api(_key), function(err, result) {
        if (err) {
           if (callback) return callback(err);
           else throw new Error('There is no Hue Station at the given address.');
        }
        _bridge = result;
        return callback && callback(null, _bridge);
    });
}

exports.discoverViaUPnP = function(timeout, callback) {

  if (typeof(callback) == "undefined") {
    callback = timeout;
    timeout = 5000;
  }

  var os = require('os');
  var dgram = require('dgram');

  /* get a list of our local IPv4 addresses */

  var interfaces = os.networkInterfaces();
  var addresses = [];
  for (var dev in interfaces) {
    for (var i = 0; i < interfaces[dev].length; i++) {
      if (interfaces[dev][i].family != 'IPv4') continue;
      if (interfaces[dev][i].internal) continue;
      addresses.push(interfaces[dev][i].address);
    }
  }

  /* this code adapted from https://github.com/Burgestrand/ruhue/blob/master/lib/ruhue.rb#L23 */

  var socket = dgram.createSocket("udp4");
  socket.bind(function () {;
    socket.setBroadcast(true);
    socket.setMulticastTTL(128);
    addresses.forEach(function (address) { socket.addMembership("239.255.255.250", address); });
    var payload = new Buffer([
        "M-SEARCH * HTTP/1.1",
        "HOST: 239.255.255.250:1900",
        "MAN: ssdp:discover",
        "MX: 10",
        "ST: ssdp:all"
    ].join("\n"));
    socket.on("error", console.error);
    var timer = null;
    socket.on("message", function (msg, rinfo) {
      // a response from a HUE will look something like this
      // HTTP/1.1 200 OK
      // CACHE-CONTROL: max-age=100
      // EXT:
      // LOCATION: http://192.168.1.99:80/description.xml
      // SERVER: FreeRTOS/6.0.5, UPnP/1.0, IpBridge/0.1
      // ST: upnp:rootdevice
      // USN: uuid:2e502f50-db51-11e1-9e45-05178509585a::upnp:rootdevice
      if (msg.toString('utf8').match(/IpBridge/)) { // check to see if it's a HUE responding
        socket.close();
        if (timer) clearTimeout(timer);
        // parse the response into an object
        var response = msg.toString('utf8').split("\r\n")
          .map(function (line) { return line.split(": "); })
          .filter(function (a) { return a.length == 2; })
          .reduce(function (obj, v) { obj[v[0]] = v[1]; return obj; }, {});
        // pull out the last 6 octets of the USN uuid, this will be used to construct the id and the mac address
        var tmp = response["USN"].match(/-([0-9a-f]{12}):/)[1];
        // now construct a result which matches that produced by the portal API
        var results = {
          id: [tmp.substring(0, 6), "fffe", tmp.substring(6)].join(""), // cf. http://www.tcpipguide.com/free/t_IPv6InterfaceIdentifiersandPhysicalAddressMapping-2.htm
          internalipaddress: rinfo.address,
          macaddress: [0,2,4,6,8,10].map(function (i) { return tmp.substring(i, 2); }).join(":"),
          source: "UPnP"
        }
        callback(null, results);
      }
    });
    socket.send(payload, 0, payload.length, 1900, "239.255.255.250", function () {
      timer = setTimeout(function () { socket.close(); callback("discovery timeout expired"); }, timeout);
    });
  });

}

exports.discoverViaPortal = function(timeout, callback) {

  // NOTE: timeout ignored for now
  if (typeof(callback) == "undefined") callback = timeout;

  http.jsonGet('www.meethue.com', '/api/nupnp', function (error, results) {
    if (error) return callback(error);
    if (results.length == 0) return callback("no bridges found on local network");
    results = results.shift();
    results.source = "www.meethue.com";
    callback(null, results);
  });

}

// Seems to be no rhyme or reason to which method is faster/more reliable, so
// this just tries both disovery methods and lets the fastest one win.
exports.discover = function (timeout, callback) {

  if (typeof(callback) == "undefined") {
    callback = timeout;
    timeout = 5000;
  }

  // TODO: check some env variable like process.env.HUE_HOST and skip discovery if defined?

  exports.once('discovered', callback);
  exports.discoverViaUPnP(timeout, exports.emit.bind(exports, 'discovered'));
  exports.discoverViaPortal(timeout, exports.emit.bind(exports, 'discovered'));
}


exports.load = function(host, key, callback) {
    if (!host || !key) {
        var e = new Error('IP Address and application name are both required parameters.');
        if (callback) return callback(e);
        else throw e;
    }

    _bridge = null;
    _host = host;
    _key = key; //crypto.createHash('md5').update(appName).digest("hex");
    
    return withConnection(callback);
}

exports.lights = function(callback) {

    function buildResults(result) {
        var lights = [],
            id;
        for(id in result)
            if(result.hasOwnProperty(id))
                lights.push(light.create().set({ "id": id, "name": result[id].name }));
        return lights;
    }
    function process(err, result){
        callback(err, buildResults(result));
    }
        
    withConnection(function(){ http.jsonGet(_host, path.lights(_key), process); }); 
}

exports.light = function(id, callback) {
    if(!callback) callback = function() {};
        
    function process(err, result){
        callback(light.create().set(result.state).set({ "name": result.name, "id": id }));
    }
    
    withConnection(function(){ http.jsonGet(_host, path.lights(_key, id), process); }); 
}

exports.groups = function(callback) {
    if(!callback) callback = function() {}; 
    
    function buildResults(result) {
        
        var groups = [],
            id;
        for(id in result)
            if(result.hasOwnProperty(id))
                groups.push(group.create().set({ "id": id, "name": result[id].name }));
        return groups;
    }
    function process(err, result) {
        callback(buildResults(result));
    }
        
    withConnection(function(){ http.jsonGet(_host, path.groups(_key), process); }); 
}

exports.group = function(id, callback) {
    if(!callback) callback = function() {};
        
    function process(err, result) {
        console.log(result);
        callback(group.create().set(result.action).set({ "name": result.name, "id": id }));
    }
    withConnection(function(){ http.jsonGet(_host, path.groups(_key, id), process); }); 
}

exports.createGroup = function(name, lights, callback) {
    if(!callback) callback = function() {};
    
    var values = {
            "name"  : name,
            "lights": _intArrayToStringArray(lights)
        };

    withConnection(function(){ http.httpPost(_host, path.groups(_key, null), values); }); 
}

exports.change = function(object, callback){
    var location;
    
    if(object.type == 'group'){
        console.log("group");
        location = path.groupState(_key, object.id)
    }else
        location = path.lightState(_key, object.id);
        
    withConnection(function(){ http.httpPut(_host, location, object, callback); });
}

// update the non-state information for an object (currently that's only name)
exports.update = function(object, values){
    var location = path.lights(_key, object.id);
    withConnection(function(){ http.httpPut(_host, location, values); });
}

function _intArrayToStringArray(array){
    retArr = [];
    for(entry in array)
        retArr.push(array[entry]+"");
    return retArr;
}
