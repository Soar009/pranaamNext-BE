const { filters } = require('./dashboard.service');
class OperationsService {
  constructor(repository) { this.repo = repository; }
  async dashboard(user, query) {
    const f = filters(query);
    const data = await this.repo.operations(user, f);
    return { filters: { airportCode: f.airportCode, from: f.from, to: f.to }, ...data };
  }
}
module.exports = { OperationsService };
