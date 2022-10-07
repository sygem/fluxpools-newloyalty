var fs = require('fs');
const bitcoin = require('bitgo-utxo-lib');
const axios = require('axios');
const { MongoClient } = require('mongodb')

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
  var loyaltyOptions = JSON.parse(fs.readFileSync('flux.loyalty.json'));
  const dataFile = process.argv[2];
  let data = JSON.parse(fs.readFileSync(dataFile));

  const mongoConnection = new MongoClient(loyaltyOptions.mongo.uri, { useUnifiedTopology: true}, { useNewUrlParser: true }, { connectTimeoutMS: 30000 }, { keepAlive: 1})
  await mongoConnection.connect()
  mongodb = mongoConnection.db(`${loyaltyOptions.mongo.database}`)

  console.log('Connected to Mongo database')

  //console.log(data);
  let payouts = [];
  let total = 0;
  for (var i = 0; i < data.length; i++) {
    let loyalty = data[i];
    let hashrate = loyalty.hashrate * 2 / 1000000;
    if (hashrate > loyaltyOptions.hashrateMax) hashrate = loyaltyOptions.hashrateMax;
    let payout = hashrate / loyaltyOptions.hashrateMax * loyaltyOptions.rewardMax;
    payouts.push({
      address: loyalty.miner,
      amount: Math.floor(payout*1e8),
      hashrate: hashrate,
    })
    total += payout;
  }
  //console.log(payouts);
  console.log(`Total: ${total}`);

  const addrData = await axios.get(`https://explorer.runonflux.io/api/addr/${loyaltyOptions.address}`)
  //console.log(addrData.data);
  if (addrData.data.balance < total) {
    console.error('Not enough funds');
    process.exit();
  }

  const transaction = new bitcoin.TransactionBuilder(getNetwork(loyaltyOptions.network));
  if (loyaltyOptions.networkVersion) {
      transaction.setVersion(loyaltyOptions.networkVersion, loyaltyOptions.overwinter);
  }
  if (loyaltyOptions.networkVersionGroupId) {
      transaction.setVersionGroupId(parseInt(loyaltyOptions.networkVersionGroupId, 16));
  }

  const utxos = await axios.get(`https://explorer.runonflux.io/api/addr/${loyaltyOptions.address}/utxo`);
  console.log("Loyalty: UTXOs");
  // console.log(utxos);
  var addedTotal = 0;
  var history = [];
  for (var i=0;i<utxos.data.length;i++) {
      const utxo = utxos.data[i];
      if ((utxo.satoshis > 0 && utxo.confirmations > 100) || (utxo.confirmations > 1 && utxo.satoshis > 75000000)) { // ignore any pool rewards
          transaction.addInput(utxo.txid, utxo.vout);
          history.push({satoshis: utxo.satoshis})
          console.log(`Added utxo: ${JSON.stringify(utxo)}`)
          addedTotal += utxo.satoshis;
          console.log(addedTotal);
          if (addedTotal > (total+loyaltyOptions.transactionFee)*1e8) {
              break;  
          }
      }
  }

  // add outputs to the transaction
  var outputTotal = 0;
  for (let payout in payouts) {
      if (payouts[payout].amount > 0) {
          transaction.addOutput(payouts[payout].address, payouts[payout].amount);
          outputTotal += payouts[payout].amount;
        }
  }
  console.log(`Added total: ${addedTotal}`)
  console.log(`Output total: ${outputTotal}`)
  // add another output to collect the change
  console.log("Change amount: "+Math.floor(addedTotal - outputTotal - (loyaltyOptions.transactionFee*1e8)));
  transaction.addOutput(loyaltyOptions.address, Math.floor(addedTotal - outputTotal - (loyaltyOptions.transactionFee*1e8)));
  
  var keyPair = bitcoin.ECPair.fromWIF(loyaltyOptions.privatekey, getNetwork(loyaltyOptions.network))
  const hashType = bitcoin.Transaction.SIGHASH_ALL
  for (let i = 0; i < transaction.inputs.length; i++) {
      transaction.sign(i, keyPair, null, hashType, history[i].satoshis);
  }

  const result = transaction.build();
  //console.log(result.toHex())

  if (loyaltyOptions.test) {
    console.log('Calling decoderawtransaction');
    axios.post('https://api.runonflux.io/daemon/decoderawtransaction',{
      hexstring: result.toHex(),
    },{
      headers: {
          'Content-Length': 0,
          'Content-Type': 'text/plain'
      },
      responseType: 'json'
    }).then(async (response) => {
      //console.log(response.data);
      if (response.data.status == 'success') {
        console.log(`TXID: ${response.data.data.txid}`)
        process.exit()
      } else {
        console.log('Fail:')
        console.log(JSON.stringify(reponse.data, null, 2))
      }
    });
  } else {
    console.log('Calling sendrawtransaction');
    axios.post('https://api.runonflux.io/daemon/sendrawtransaction',{
      hexstring: result.toHex(),
    },{
      headers: {
          'Content-Length': 0,
          'Content-Type': 'text/plain'
      },
      responseType: 'json'
    }).then(async (response) => {
      console.log(response.data);
      if (response.data.status == 'success') {
        console.log(`TXID: ${response.data.data}`)
        await addLoyaltyToMongo(response.data.data, payouts, mongodb, loyaltyOptions)
        process.exit()
      } else {
        console.log('Fail:')
        console.log(JSON.stringify(reponse.data, null, 2))
      }
    });
  }

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

function getNetwork(network) {
  return bitcoin.networks[network];
}

