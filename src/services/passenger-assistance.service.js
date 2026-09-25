const { ApiError } = require('../utils/errors');
class PassengerAssistanceService {
  constructor(repo, support) { this.repo = repo; this.support = support; }
  async get(user,tripId) {
    if (typeof tripId !== 'string' || !/^[A-Za-z0-9-]{1,50}$/.test(tripId)) throw new ApiError(400,'VALIDATION_FAILED','Invalid trip ID');
    const row = await this.repo.find(tripId,user.id);
    if (!row) throw new ApiError(404,'NOT_FOUND','Trip not found');
    return { trip: { tripId:row.tripId,status:row.status,airportCode:row.airportCode,
      airportName:row.airportName,flightNumber:row.flightNumber,flightDate:row.flightDate },
      gro:row.gro,groAssigned:Boolean(row.gro),...this.support };
  }
}
module.exports = { PassengerAssistanceService };
