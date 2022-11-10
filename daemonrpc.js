// inspired by bitcoin-promise packackge

const bitcoin = require('bitcoin')

const _methods = [
  'getBlock',
  'getRawTransaction',
  'createRawTransaction',
  'decodeRawTransaction',
  'listunspent',
  'signrawtransaction',
  'sendRawTransaction',
  'getinfo',
  'getBlockHeader',
  'getBlockSubsidy',
  'disconnectNode',
  'clearBanned',
  'getDeprecationInfo',
  'listBanned',
  'setBan',
  'fundRawTransaction',
]
// ===----------------------------------------------------------------------===//
// callRpc
// ===----------------------------------------------------------------------===//
function callRpc(cmd, args, rpc) {
  let promise = null
  const fn = args[args.length - 1]

  // If the last argument is a callback, pop it from the args list
  if (typeof fn === 'function') {
    args.pop()
    rpc.call(cmd, args, function () {
      const args = [].slice.call(arguments)
      args.unshift(null)
      fn.apply(this, args)
    }, function (err) {
      fn(err)
    })
  } else {
    // .....................................................
    // if no callback function is passed - return a promise
    // .....................................................
    promise = new Promise(function (resolve, reject) {
      rpc.call(cmd, args, function () {
        const args = [].slice.call(arguments)
        args.unshift(null)
        // ----------------------
        // args is err,data,hdrs
        // but we can only pass 1 thing back
        // rather than make a compound object - ignore the headers
        // errors are handled in the reject below
        resolve(args[1])
      }, function (err) {
        reject(err)
      })
    })
    // Return the promise here
    return promise
  }
}

(function () {
  const methods = Object.getOwnPropertyNames(bitcoin.Client.prototype).filter(function (p) {
    return typeof bitcoin.Client.prototype[p] === 'function' && p !== 'cmd' && p !== 'constructor'
  })
  for (let i = 0; i < methods.length; i++) {
    const protoFn = methods[i];
    (function (protoFn) {
      bitcoin.Client.prototype[protoFn] = function () {
        const args = [].slice.call(arguments)
        return callRpc(protoFn.toLowerCase(), args, this.rpc)
      }
    })(protoFn)
  }

  for (let i = 0; i < _methods.length; i++) {
    const protoFn = _methods[i];
    (function (protoFn) {
      bitcoin.Client.prototype[protoFn] = function () {
        const args = [].slice.call(arguments)
        return callRpc(protoFn.toLowerCase(), args, this.rpc)
      }
    })(protoFn)
  }
})()

module.exports.Client = bitcoin.Client
