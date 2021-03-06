const config = require('../../src/config.js')
const mongoose = require('mongoose')
const Profile = require('../../src/structs/db/Profile.js')
const Feed = require('../../src/structs/db/Feed.js')
const FilteredFormat = require('../../src/structs/db/FilteredFormat.js')
const Subscriber = require('../../src/structs/db/Subscriber.js')
const FailRecord = require('../../src/structs/db/FailRecord.js')
const GuildData = require('../../src/structs/GuildData.js')

function HEXToVBColor (rrggbb) {
  const bbggrr = rrggbb.substr(4, 2) + rrggbb.substr(2, 2) + rrggbb.substr(0, 2)
  return parseInt(bbggrr, 16)
}

function sanitizeFilters (target) {
  const filters = target.filters
  if (filters) {
    for (const key in filters) {
      if (key.includes('.')) {
        delete filters[key]
      }
    }
  }
}

function getOldDate (hoursAgo) {
  // https://stackoverflow.com/questions/1050720/adding-hours-to-javascript-date-object
  const date = new Date()
  date.setTime(date.getTime() - hoursAgo * 60 * 60 * 1000)
  return date
}

async function updateFailRecords (doc) {
  const insert = {
    url: doc.link
  }
  if (doc.failed) {
    insert.reason = doc.failed
    const record = new FailRecord(insert)
    const oldDate = getOldDate(config.feeds.hoursUntilFail + 1)
    record.failedAt = oldDate.toISOString()
    await record.save()
  } else {
    const record = new FailRecord(insert)
    await record.save()
  }
}

async function updateProfiles (guildRss) {
  const data = {
    feeds: [],
    filteredFormats: [],
    subscribers: []
  }
  // Profile first
  delete guildRss.version
  const profile = new Profile({
    ...guildRss,
    _id: guildRss.id,
    alert: guildRss.sendAlertsTo || []
  })
  const profileJSON = profile.toJSON()
  let populatedProfile = false
  for (const key in profileJSON) {
    if (key === '_id' || key === 'name') {
      continue
    }
    const value = profileJSON[key]
    if (key === 'alert') {
      if (value.length > 0) {
        populatedProfile = true
      }
      continue
    }
    if (value !== undefined) {
      populatedProfile = true
    }
  }
  if (populatedProfile) {
    data.profile = profileJSON
  }

  const rssList = guildRss.sources
  if (rssList) {
    for (const rssName in rssList) {
      // Feed
      const feed = { ...rssList[rssName] }
      feed.url = feed.link
      feed.guild = guildRss.id
      feed._id = new mongoose.Types.ObjectId().toHexString()
      // Since mongoose map keys cannot have dots, remove them
      sanitizeFilters(feed)

      // Format
      const text = feed.message
      if (text) {
        feed.text = text
      }
      const embeds = feed.embeds
      if (Array.isArray(embeds) && embeds.length > 0) {
        for (const embed of embeds) {
          // Convert hex strings to numbers
          if (embed.color && isNaN(Number(embed.color))) {
            embed.color = HEXToVBColor(embed.color)
          }

          // Remove non-array fields
          if (!Array.isArray(embed.fields)) {
            delete embed.fields
          }
        }
        FilteredFormat.pruneEmbeds(embeds)
      } else {
        delete feed.embeds
      }

      // Check titles
      if (feed.checkTitles) {
        feed.ncomparisons = ['title']
      }

      data.feeds.push(new Feed(feed).toJSON())

      // Subscribers
      const feedSubscribers = feed.subscribers
      if (feedSubscribers && feedSubscribers.length > 0) {
        for (const s of feedSubscribers) {
          sanitizeFilters(s)
          const subscriber = new Subscriber({
            ...s,
            feed: feed._id
          })
          data.subscribers.push(subscriber.toJSON())
        }
      }
    }
  }

  const guildData = new GuildData(data)
  await guildData.restore()
}

async function startProfiles () {
  console.log('Starting profile migration')
  const guildRssList = await mongoose.connection.collection('guilds').find({}).toArray()
  let c = 0
  const total = guildRssList.length
  const errors = []
  for (const guildRss of guildRssList) {
    updateProfiles(guildRss).catch(error => {
      errors.push({
        error,
        data: guildRss
      })
    }).finally(() => {
      console.log(`Profile: ${++c}/${total}`)
      if (c === total) {
        complete(errors)
        startFailRecords()
      }
    })
  }
}

async function startFailRecords () {
  console.log('Starting fail counters migration')
  const failedLinks = await mongoose.connection.collection('failed_links').find({}).toArray()
  let c = 0
  const total = failedLinks.length
  const errors = []
  for (const failedLink of failedLinks) {
    updateFailRecords(failedLink).catch(error => {
      errors.push({
        error,
        data: failedLink
      })
    }).finally(() => {
      console.log(`Counter ${++c}/${total}`)
      if (c === total) {
        complete(errors)
        mongoose.connection.close()
      }
    })
  }
}

function complete (errors) {
  console.log(`Complete with ${errors.length} errors`)
  if (errors.length > 0) {
    for (const item of errors) {
      console.log(item.error)
      console.log(JSON.stringify(item.data, null, 2))
    }
  }
}

exports.updateProfiles = updateProfiles
exports.updateFailRecords = updateFailRecords
exports.run = startProfiles
