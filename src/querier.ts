import _ from 'lodash';
import { Observable } from 'rxjs';
import 'rxjs/add/observable/empty';
import 'rxjs/add/observable/from';
import 'rxjs/add/observable/defer';
import 'rxjs/add/operator/concat';
import 'rxjs/add/operator/mergeMap';

export class SumologicQuerier {
    params: any;
    format: string;
    timeoutSec: number;
    useObservable: boolean;
    datasource: any;
    backendSrv: any;
    retryCount: number;
    offset: number;
    maximumOffset: number;
    startTime: Date;
    state: string;
    job: any;
    status: any;
    messageCount: number;
    recordCount: number;

    constructor(params, format, timeoutSec, useObservable, datasource, backendSrv) {
        this.params = params;
        this.format = format;
        this.timeoutSec = timeoutSec;
        this.useObservable = useObservable;
        this.datasource = datasource;
        this.backendSrv = backendSrv;
        this.retryCount = 0;
        this.offset = 0;
        this.maximumOffset = 10000;
    }

    getResult() {
        this.startTime = new Date();
        if (!this.useObservable) {
            return this.delay(() => {
                return this.transition('CREATE_SEARCH_JOB');
            }, Math.random() * 1000);
        } else {
            return Observable.defer(() => {
                return this.delay(() => {
                    return this.transition('CREATE_SEARCH_JOB');
                }, Math.random() * 1000);
            });
        }
    }

    transition(state) {
        this.state = state;
        this.retryCount = 0;
        if (!this.useObservable) {
            return this.loop();
        } else {
            return this.loopForObservable();
        }
    }

    retry() {
        this.retryCount += 1;
        return this.delay(() => {
            if (!this.useObservable) {
                return this.loop();
            } else {
                return this.loopForObservable();
            }
        }, this.calculateRetryWait(1000, this.retryCount));
    }

    loop() {
        if (this.job) {
            let now = new Date();
            if (now.valueOf() - this.startTime.valueOf() > (this.timeoutSec * 1000)) {
                console.error('timeout');
                return this.doRequest('DELETE', '/v1/search/jobs/' + this.job.data.id).then((result) => {
                    return Promise.reject({ message: 'timeout' });
                });
            }
        }

        switch (this.state) {
            case 'CREATE_SEARCH_JOB':
                return this.doRequest('POST', '/v1/search/jobs', this.params).then((job) => {
                    this.job = job;
                    return this.transition('REQUEST_STATUS');
                });
                break;
            case 'REQUEST_STATUS':
                return this.doRequest('GET', '/v1/search/jobs/' + this.job.data.id).then((status) => {
                    this.status = status;
                    if (this.status.data.state !== 'DONE GATHERING RESULTS') {
                        if (this.retryCount < 20) {
                            return this.retry();
                        } else {
                            return Promise.reject({ message: 'max retries exceeded' });
                        }
                    }

                    if (!_.isEmpty(this.status.data.pendingErrors) || !_.isEmpty(this.status.data.pendingWarnings)) {
                        let message = '';
                        if (!_.isEmpty(this.status.data.pendingErrors)) {
                            message += 'Error:\n' + this.status.data.pendingErrors.join('\n') + '\n';
                        }
                        if (!_.isEmpty(this.status.data.pendingWarnings)) {
                            message += 'Warning:\n' + this.status.data.pendingWarnings.join('\n');
                        }
                        return Promise.reject({ message: message });
                    }
                    return this.transition('REQUEST_RESULTS');
                }).catch((err) => {
                    if (err.data && err.data.code && err.data.code === 'unauthorized') {
                        return Promise.reject(err);
                    }
                    // need to wait until job is created and registered
                    if (this.retryCount < 6 && err.data && err.data.code && err.data.code === 'searchjob.jobid.invalid') {
                        return this.retry();
                    } else {
                        return Promise.reject(err);
                    }
                });
                break;
            case 'REQUEST_RESULTS':
                if (this.format === 'time_series_records' || this.format === 'records') {
                    if (this.status.data.recordCount === 0) {
                        return Promise.resolve([]);
                    }
                    let limit = Math.min(this.maximumOffset, this.status.data.recordCount);
                    return this.doRequest('GET', '/v1/search/jobs/' + this.job.data.id + '/records?offset=0&limit=' + limit).then((response) => {
                        return response.data;
                    });
                } else if (this.format === 'messages') {
                    if (this.status.data.messageCount === 0) {
                        return Promise.resolve([]);
                    }
                    let limit = Math.min(this.maximumOffset, this.status.data.messageCount);
                    return this.doRequest('GET', '/v1/search/jobs/' + this.job.data.id + '/messages?offset=0&limit=' + limit).then((response) => {
                        return response.data;
                    });
                } else {
                    return Promise.reject({ message: 'unsupported type' });
                }
                break;
        }
    }

    loopForObservable() {
        if (this.job) {
            let now = new Date();
            if (now.valueOf() - this.startTime.valueOf() > (this.timeoutSec * 1000)) {
                console.error('timeout');
                return this.doRequest('DELETE', '/v1/search/jobs/' + this.job.data.id).then((result) => {
                    return Promise.reject({ message: 'timeout' });
                });
            }
        }

        switch (this.state) {
            case 'CREATE_SEARCH_JOB':
                return this.doRequest('POST', '/v1/search/jobs', this.params).then((job) => {
                    this.job = job;
                    return this.transition('REQUEST_STATUS');
                });
                break;
            case 'REQUEST_STATUS':
                return this.doRequest('GET', '/v1/search/jobs/' + this.job.data.id).then((status) => {
                    this.status = status;
                    let prevMessageCount = this.messageCount;
                    let prevRecordCount = this.recordCount;
                    this.messageCount = this.status.data.messageCount;
                    this.recordCount = this.status.data.recordCount;

                    if (!_.isEmpty(this.status.data.pendingErrors) || !_.isEmpty(this.status.data.pendingWarnings)) {
                        return Promise.reject({ message: this.status.data.pendingErrors.concat(this.status.data.pendingWarnings).join('\n') });
                    }

                    if (this.status.data.state === 'DONE GATHERING RESULTS') {
                        return this.transition('REQUEST_RESULTS');
                    }

                    if ((this.format === 'time_series_records' || this.format === 'records') && this.recordCount > prevRecordCount) {
                        return this.transition('REQUEST_RESULTS');
                    }
                    if (this.format === 'messages' && this.messageCount > prevMessageCount) {
                        return this.transition('REQUEST_RESULTS');
                    }

                    // wait for new result arrival
                    return this.transition('REQUEST_STATUS');
                }).catch((err) => {
                    if (err.data && err.data.code && err.data.code === 'unauthorized') {
                        return Promise.reject(err);
                    }
                    // need to wait until job is created and registered
                    if (this.retryCount < 6 && err.data && err.data.code && err.data.code === 'searchjob.jobid.invalid') {
                        return this.retry();
                    } else {
                        return Promise.reject(err);
                    }
                });
                break;
            case 'REQUEST_RESULTS':
                if (this.format === 'time_series_records' || this.format === 'records') {
                    let limit = Math.min(this.maximumOffset, this.status.data.recordCount) - this.offset;
                    if (limit === 0) {
                        return Observable.empty();
                    }
                    return this.doRequest('GET', '/v1/search/jobs/' + this.job.data.id + '/records?offset=' + this.offset + '&limit=' + limit).then((response) => {
                        this.offset += response.data.records.length;
                        if (this.status.data.state === 'DONE GATHERING RESULTS' || this.offset >= this.maximumOffset) {
                            return Observable.from([response.data]);
                        }
                        return Observable.from([response.data])
                            .concat(
                                Observable.defer(() => {
                                    return this.transition('REQUEST_STATUS');
                                }).mergeMap((value: any) => value)
                            );
                    });
                } else if (this.format === 'messages') {
                    let limit = Math.min(this.maximumOffset, this.status.data.messageCount) - this.offset;
                    if (limit === 0) {
                        return Observable.empty();
                    }
                    return this.doRequest('GET', '/v1/search/jobs/' + this.job.data.id + '/messages?offset=' + this.offset + '&limit=' + limit).then((response) => {
                        this.offset += response.data.messages.length;
                        if (this.status.data.state === 'DONE GATHERING RESULTS' || this.offset >= this.maximumOffset) {
                            return Observable.from([response.data]);
                        }
                        return Observable.from([response.data])
                            .concat(
                                Observable.defer(() => {
                                    return this.transition('REQUEST_STATUS');
                                }).mergeMap((value: any) => value)
                            );
                    });
                } else {
                    return Promise.reject({ message: 'unsupported type' });
                }
                break;
        }
    }

    doRequest(method, path, params = {}) {
        if (this.datasource.token === 0) {
            return this.delay(() => {
                return this.doRequest(method, path, params);
            }, Math.ceil(1000 / this.datasource.MAX_AVAILABLE_TOKEN));
        }

        let options: any = {
            method: method,
            url: this.datasource.url + path,
            data: params,
            headers: {},
            inspect: { type: 'sumologic' },
            withCredentials: false
        };

        if (this.datasource.basicAuth || this.datasource.withCredentials) {
            options.withCredentials = true;
        }
        if (this.datasource.basicAuth) {
            options.headers.Authorization = this.datasource.basicAuth;
        }
        options.headers['Content-Type'] = 'application/json';

        this.datasource.token--;
        if (this.datasource.tokenTimer === null) {
            this.datasource.tokenTimer = setInterval(() => {
                this.datasource.provideToken();
            }, Math.ceil(1000 / this.datasource.MAX_AVAILABLE_TOKEN));
        }

        return this.backendSrv.datasourceRequest(options).catch((err) => {
            if (err.data && err.data.code && err.data.code === 'rate.limit.exceeded') {
                this.datasource.token = 0;
                return this.retryable(3, (retryCount) => {
                    return this.delay(() => {
                        return this.backendSrv.datasourceRequest(options);
                    }, this.calculateRetryWait(1000, retryCount));
                }).catch((err) => {
                    console.error('rate limit exceeded');
                    return err;
                });
            } else {
                console.error(err);
                return Promise.reject(err);
            }
        });
    }

    delay(func, wait) {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                func().then(resolve, reject);
            }, wait);
        });
    }

    retryable(retryCount, func) {
        let promise = Promise.reject({}).catch(() => func(retryCount));
        for (let i = 0; i < retryCount; i++) {
            ((i) => {
                promise = promise.catch(err => func(i + 1));
            })(i);
        }
        return promise;
    }

    calculateRetryWait(initialWait, retryCount) {
        return initialWait * Math.min(10, Math.pow(2, retryCount)) +
            Math.floor(Math.random() * 1000);
    }
}
