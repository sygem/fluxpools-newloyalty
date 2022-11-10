var fs = require('fs');
const bitcoin = require('bitgo-utxo-lib');
const axios = require('axios');
const { MongoClient } = require('mongodb')
const daemonrpc = require('./daemonrpc')

const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
})

function question(query) {
  return new Promise(resolve => {
      readline.question(query, resolve)
  })
}

run();

async function run() {
  var loyaltyOptions = JSON.parse(fs.readFileSync('neoxa.loyalty.json'));
  //const dataFile = process.argv[2];
  //let data = JSON.parse(fs.readFileSync(dataFile));
  const data = await axios.get('https://api-neoxa.fluxpools.net/loyalty/7/97/json');

  /*const mongoConnection = new MongoClient(loyaltyOptions.mongo.uri, { useUnifiedTopology: true}, { useNewUrlParser: true }, { connectTimeoutMS: 30000 }, { keepAlive: 1})
  await mongoConnection.connect()
  mongodb = mongoConnection.db(`${loyaltyOptions.mongo.database}`)

  console.log('Connected to Mongo database')

  const loyaltyCollection = mongodb.collection('loyalty')
  let data = await loyaltyCollection.find({uptime:{$gt: loyaltyOptions.uptime}}).toArray()*/

  //console.log(data.data);
  let payouts = [];
  let outputs = {};
  let total = 0;
  for (var i = 0; i < data.data.length; i++) {
    let loyalty = data.data[i];
    let hashrate = loyalty.hashrate;
    
    if (hashrate > loyaltyOptions.hashrateMax) hashrate = loyaltyOptions.hashrateMax;
    let payout = hashrate / loyaltyOptions.hashrateMax * loyaltyOptions.rewardMax;
    payouts.push({
      address: loyalty.miner,
      amount: payout,
      hashrate: hashrate,
    })
    //var outObj = {}
    //outObj[`${loyalty.miner}`] = payout
    //outputs.push(outObj)
    outputs[`${loyalty.miner}`] = Math.round(payout * 100000000) / 100000000
    total += payout;
  }
  console.log(`Total: ${total}`);

  const client = new daemonrpc.Client({
    port: (loyaltyOptions.testnet === true ? loyaltyOptions.daemon.testnetrpcport : loyaltyOptions.daemon.rpcport),
    user: loyaltyOptions.daemon.rpcuser,
    pass: loyaltyOptions.daemon.rpcpassword,
    timeout: 60000
  })

  let utxos
  try {
    utxos = await client.listunspent(1, 999999999, [loyaltyOptions.address])
  } catch (error) {
    console.error(`Unable to get UTXOs for '${loyaltyOptions.address}'`)
    console.error(error)
    process.exit()
  }

  console.log("Loyalty: UTXOs");
  //console.log(utxos);
  var addedTotal = 0;
  var inputs = [];
  for (var i=0;i<utxos.length;i++) {
      const utxo = utxos[i];
      if ((utxo.amount > 0 && utxo.confirmations > 100)) {
          //transaction.addInput(utxo.txid, utxo.vout);
          inputs.push({txid: utxo.txid, vout: utxo.vout})
          console.log(`Added utxo: ${JSON.stringify(utxo)}`)
          addedTotal += utxo.amount;
          console.log(addedTotal);
          if (addedTotal > (total+loyaltyOptions.transactionFee)) {
              break;  
          }
      }
  }

  console.log(`Added Total: ${addedTotal}`);
  console.log(`Output Total: ${total}`);
  console.log(`TX Fee: ${loyaltyOptions.transactionFee}`);

  console.log("Change amount: "+(addedTotal - total - loyaltyOptions.transactionFee));
  //transaction.addOutput(loyaltyOptions.address, Math.floor(addedTotal - outputTotal - (loyaltyOptions.transactionFee*1e8)));
  outputs[`${loyaltyOptions.address}`] = Math.round((addedTotal - total - loyaltyOptions.transactionFee) * 100000000) / 100000000

  console.log(inputs)
  console.log(outputs)

  let rawhex = await client.createRawTransaction(inputs, outputs)
  console.log(typeof(rawhex))
  console.log('Signing');
  let signedTx = await client.signrawtransaction(rawhex)
  console.log('Signed');
  
  if (signedTx.errors || !signedTx.hex || !signedTx.complete) {
    console.error(`Signed transaction has errors: ${signedTx}`)
    process.exit()
  }
  if (loyaltyOptions.test) {
    let decoded = await client.decodeRawTransaction(signedTx.hex)
    console.log(decoded)
  } else {
    let txid = await client.sendRawTransaction(signedTx)
    console.log(txid)
    //await addLoyaltyToMongo(response.data.data, payouts, mongodb, loyaltyOptions)
  }

  process.exit()

}

async function addLoyaltyToMongo(tx, payouts, mongodb, loyaltyOptions) {
  const now = Date.now()
  let data = {
    timestamp: now,
    tx: tx,
    miners: payouts,
    maxReward: loyaltyOptions.rewardMax,
    maxHashrate: loyaltyOptions.hashrateMax,
  }
  const collection = mongodb.collection('loyalty_payouts')
  await collection.insertOne(data)

  let bulkOps = []
  for (let i = 0; i < payouts.length; i++) {
    const payout = payouts[i]
    const index = `payouts.${now}`
    bulkOps.push({
      updateOne: {
        filter: { miner: payout.address },
        update: { $inc: { total: payout.amount }, $set: { [index]: { amount: payout.amount }}},
        upsert: true,
      }
    })
  }
  const loyaltyDeetsCollection = mongodb.collection('loyalty_details')
  await loyaltyDeetsCollection.bulkWrite(bulkOps)

  const statsCollection = mongodb.collection('stats')
  const stats = await statsCollection.findOne({type:'newLoyaltyConfig'})
  stats.value.loyalty.lastpayout = now
  // now to insert into mongo
  await statsCollection.updateOne({type:'newLoyaltyConfig'}, {$set: stats}, {upsert: true})
}

