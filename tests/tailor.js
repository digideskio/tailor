'use strict';
const assert = require('assert');
const http = require('http');
const nock = require('nock');
const sinon = require('sinon');
const Tailor = require('../index');
const PassThrough = require('stream').PassThrough;

describe('Tailor', () => {

    let server;
    const mockTemplate = sinon.stub();
    const mockContext = sinon.stub();
    const cacheTemplate = sinon.spy();

    beforeEach((done) => {
        const tailor = new Tailor({
            fetchContext: mockContext,
            pipeDefinition: () => new Buffer(''),
            fetchTemplate: (request, parseTemplate) => {
                const template = mockTemplate(request);
                if (template) {
                    if (typeof template === 'string') {
                        return parseTemplate(template).then((parsedTemplate) => {
                            const cache = [];
                            parsedTemplate.on('data', (data) => cache.push(data));
                            parsedTemplate.on('end', function () {
                                cacheTemplate(cache);
                            });
                            return parsedTemplate;
                        });
                    } else if (typeof template === 'function') {
                        // assuming its a function that returns stream or string
                        return parseTemplate(template());
                    } else {
                        // resume cached template
                        const tempalteStream = new PassThrough({objectMode: true});
                        template.forEach((item) => tempalteStream.write(item));
                        tempalteStream.end();
                        return Promise.resolve(tempalteStream);
                    }
                } else {
                    return Promise.reject('Error fetching template');
                }
            },
            pipeInstanceName: () => 'p'
        });
        mockContext.returns(Promise.resolve({}));
        server = http.createServer(tailor.requestHandler);
        server.listen(8080, 'localhost', done);
    });

    afterEach((done) => {
        mockContext.reset();
        mockTemplate.reset();
        cacheTemplate.reset();
        server.close(done);
    });

    it('should return 500 if the layout wasn\'t found', (done) => {
        mockTemplate.returns(false);
        http.get('http://localhost:8080/missing-template', (response) => {
            assert.equal(response.statusCode, 500);
            response.resume();
            response.on('end', done);
        });
    });

    it('should return 500 if the template stream errored', (done) => {
        mockTemplate.returns(() => {
            const st = new PassThrough();
            setImmediate(() => st.emit('error', 'Something bad happened'));
            return st;
        });
        http.get('http://localhost:8080/missing-template', (response) => {
            assert.equal(response.statusCode, 500);
            response.resume();
            response.on('end', done);
        });

    });

    it('should allow to overide statusCode from template', (done) => {

        const tailor = new Tailor({
            fetchTemplate: (request, parseTemplate) => {
                parseTemplate = () => {
                    const st = new PassThrough();
                    st.statusCode = '503';
                    st.end('');
                    return st;
                };
                return Promise.resolve(parseTemplate());
            }
        });
        const server = http.createServer(tailor.requestHandler);
        server.listen(8888, 'localhost', () => {
            http.get('http://localhost:8888/test', (response) => {
                assert.equal(response.statusCode, 503);
                response.resume();
                response.on('end', () => {
                    server.close(done);
                });
            });
        });
    });

    it('should stream content from http and https fragments', (done) => {

        nock('https://fragment')
            .get('/1').reply(200, 'hello');

        nock('http://fragment:9000')
            .get('/2').reply(200, 'world');

        mockTemplate
            .returns(
                '<html>' +
                '<fragment id="f-1" src="https://fragment/1">' +
                '<fragment id="f-2" src="http://fragment:9000/2">' +
                '</html>'
            );

        http.get('http://localhost:8080/test', (response) => {
            let result = '';
            assert.equal(response.statusCode, 200);
            response.on('data', (data) => {
                result += data;
            });
            response.on('end', () => {
                assert.equal(
                    result,
                    '<html>' +
                    '<script data-pipe>p.start(0)</script>hello<script data-pipe>p.end(0)</script>' +
                    '<script data-pipe>p.start(1)</script>world<script data-pipe>p.end(1)</script>' +
                    '</html>'
                );
                done();
            });
        });

    });

    it('should return response code and location header ' +
       'of the 1st primary fragment', (done) => {
        nock('https://fragment')
            .get('/1').reply(200, 'hello')
            .get('/2').reply(300, 'world', {'Location': 'https://redirect'})
            .get('/3').reply(500, '!');

        mockTemplate
            .returns(
                '<html>' +
                '<fragment src="https://fragment/1"> ' +
                '<fragment src="https://fragment/2" primary> ' +
                '<fragment src="https://fragment/3" primary> ' +
                '</html>'
            );

        http.get('http://localhost:8080/test', (response) => {
            assert.equal(response.statusCode, 300);
            assert.equal(response.headers.location, 'https://redirect');
            response.resume();
            done();
        });
    });

    it('should forward headers to fragment', (done) => {

        const headers = {
            'X-Zalando-Custom': 'test',
            'Referer': 'https://google.com',
            'Accept-Language': 'en-gb',
            'User-Agent': 'MSIE6',
            'X-Wrong-Header': 'should not be forwarded',
            'Cookie': 'value'
        };

        const expectedHeaders = {
            'X-Zalando-Custom': 'test',
            'Referer': 'https://google.com',
            'Accept-Language': 'en-gb',
            'User-Agent': 'MSIE6'
        };

        nock('https://fragment', {
            reqheaders: expectedHeaders,
            badheaders: ['X-Wrong-Header', 'Cookie']
        }).get('/').reply(200);

        mockTemplate
            .returns('<fragment src="https://fragment/">');

        http.get({
            hostname: 'localhost',
            path: '/test',
            port: 8080,
            headers: headers
        }, (response) => {
            response.resume();
            done();
        });

    });

    it('should disable browser cache', (done) => {
        nock('https://fragment').get('/1').reply(200, 'hello');

        mockTemplate
            .returns('<fragment src="https://fragment/1">');

        http.get('http://localhost:8080/test', (response) => {
            const headers = response.headers;
            assert.equal('no-cache, no-store, must-revalidate', headers['cache-control']);
            assert.equal('no-cache', headers['pragma']);
            done();
        });
    });

    it('should set timeout for a fragment request', (done) => {
        nock('https://fragment')
            .get('/1').socketDelay(101).reply(200, 'hello')
            .get('/2').socketDelay(10001).reply(200, 'world');

        mockTemplate
            .returns(
                '<html>' +
                '<fragment src="https://fragment/1" timeout="100">' +
                '<fragment src="https://fragment/2">' +
                '</html>'
            );

        http.get('http://localhost:8080/test', (response) => {
            let data = '';
            response.on('data', (chunk) => {
                data += chunk;
            });
            response.on('end', () => {
                assert.equal(data, '<html></html>');
                done();
            });
        });
    });

    it('should return 500 in case of primary timeout', (done) => {
        nock('https://fragment')
            .get('/1').socketDelay(101).reply(200, 'hello');

        mockTemplate
            .returns(
                '<html>' +
                '<fragment src="https://fragment/1" primary timeout="100"> ' +
                '</html>'
            );

        http.get('http://localhost:8080/test', (response) => {
            assert.equal(response.statusCode, 500);
            response.resume();
            done();
        });
    });

    it('should return 500 in case of primary error if fallback is not specified', (done) => {
        nock('https://fragment')
            .get('/1').replyWithError('panic!');

        mockTemplate
            .returns(
                '<html>' +
                '<fragment src="https://fragment/1" primary> ' +
                '</html>'
            );

        http.get('http://localhost:8080/test', (response) => {
            assert.equal(response.statusCode, 500);
            response.resume();
            done();
        });
    });

    it('should fetch the fallback fragment when specified', (done) => {
        nock('https://fragment').
            get('/1').reply(500, 'Internal Server Error');
        nock('https://fragment').
            get('/fallback').reply(200, 'Fallback fragment');

        mockTemplate
            .returns(
                '<html>' +
                '<fragment src="https://fragment/1" fallback-src="https://fragment/fallback"> ' +
                '</html>'
            );

        http.get('http://localhost:8080/test', (response) => {
            assert.equal(response.statusCode, 200);
            response.resume();
            done();
        });
    });

    it('should return 500 if both primary and fallback fragment is not reachable', (done) => {
        nock('https://fragment').
            get('/1').replyWithError('panic!');
        nock('https://fragment').
            get('/fallback').reply(500, 'Internal Server Error');

        mockTemplate
            .returns(
                '<html>' +
                '<fragment src="https://fragment/1" primary fallback-src="https://fragment/fallback"> ' +
                '</html>'
            );

        http.get('http://localhost:8080/test', (response) => {
            assert.equal(response.statusCode, 500);
            response.resume();
            done();
        });
    });


    it('should insert link to css from fragment link header', (done) => {
        nock('https://fragment')
            .get('/1').reply(200, 'hello', {
                'Link': '<http://link>; rel="stylesheet",<http://link2>; rel="fragment-script"'
            });

        mockTemplate
            .returns('<html><fragment src="https://fragment/1"></html>');

        http.get('http://localhost:8080/test', (response) => {
            let data = '';
            response.on('data', (chunk) =>  {
                data += chunk;
            });
            response.on('end', () => {
                assert.equal(data,
                    '<html>' +
                    '<link rel="stylesheet" href="http://link">' +
                    '<script data-pipe>p.start(0, "http://link2")</script>' +
                    'hello' +
                    '<script data-pipe>p.end(0, "http://link2")</script>' +
                    '</html>'
                );
                done();
            });
        });
    });

    it('should use loadCSS from async fragments', (done) => {
        nock('https://fragment')
            .get('/1').reply(200, 'hello', {
                'Link': '<http://link>; rel="stylesheet",<http://link2>; rel="fragment-script"'
            });

        mockTemplate
            .returns('<fragment async src="https://fragment/1">');

        http.get('http://localhost:8080/test', (response) => {
            let data = '';
            response.on('data', (chunk) =>  {
                data += chunk;
            });
            response.on('end', () => {
                assert.equal(data,
                    '<script data-pipe>p.placeholder(0)</script>' +
                    '<script>p.loadCSS("http://link")</script>' +
                    '<script data-pipe>p.start(0, "http://link2")</script>' +
                    'hello' +
                    '<script data-pipe>p.end(0, "http://link2")</script>'
                );
                done();
            });
        });
    });


    it('should insert link to css and require js  from fragment x-amz-meta-link header', (done) => {
        nock('https://fragment')
            .get('/1').reply(200, 'hello', {
                'X-AMZ-META-LINK': '<http://link>; rel="stylesheet",<http://link2>; rel="fragment-script"'
            });

        mockTemplate
            .returns('<html><fragment src="https://fragment/1"></html>');

        http.get('http://localhost:8080/test', (response) => {
            let data = '';
            response.on('data', (chunk) => {
                data += chunk;
            });
            response.on('end', () => {
                assert.equal(data,
                    '<html>' +
                    '<link rel="stylesheet" href="http://link">' +
                    '<script data-pipe>p.start(0, "http://link2")</script>' +
                    'hello' +
                    '<script data-pipe>p.end(0, "http://link2")</script>' +
                    '</html>'
                );
                done();
            });
        });
    });

    it('should support async fragments', (done) => {
        nock('https://fragment')
            .get('/1').reply(200, 'hello');

        mockTemplate
            .returns(
                '<html>' +
                '<body>' +
                '<fragment src="https://fragment/1" async>' +
                '</body>' +
                '</html>'
            );

        http.get('http://localhost:8080/test', (response) => {
            let data = '';
            response.on('data', (chunk) => {
                data += chunk;
            });
            response.on('end', () => {
                assert.equal(data,
                    '<html>' +
                    '<body>' +
                    '<script data-pipe>p.placeholder(0)</script>' +
                    '<script data-pipe>p.start(0)</script>' +
                    'hello' +
                    '<script data-pipe>p.end(0)</script>' +
                    '</body>' +
                    '</html>'
                );
                done();
            });
        });
    });

    it('should replace fragment attributes with the one from context', (done) => {
        nock('https://fragment')
            .get('/yes').reply(200, 'yes');

        mockTemplate
            .returns(
                '<html>' +
                '<body>' +
                '<fragment async=false primary id="f-1" src="https://default/no">' +
                '</body>' +
                '</html>'
            );

        const contextObj = {
            'f-1' : {
                src : 'https://fragment/yes',
                primary: false,
                async: true
            }
        };
        mockContext.returns(Promise.resolve(contextObj));

        http.get('http://localhost:8080/test', (response) => {
            let result = '';
            assert.equal(response.statusCode, 200);
            response.on('data', (data) => {
                result += data;
            });
            response.on('end', () => {
                assert.equal(
                    result,
                    '<html>' +
                    '<body>' +
                    '<script data-pipe>p.placeholder(0)</script>' +
                    '<script data-pipe>p.start(0)</script>' +
                    'yes' +
                    '<script data-pipe>p.end(0)</script>' +
                    '</body>' +
                    '</html>'
                );
                done();
            });
        });
    });

    it('should not mutate the template with the context', (done) => {
        nock('https://fragment')
            .get('/yes').reply(200, 'yes');

        nock('https://fragment')
            .get('/no').reply(200, 'no');

        mockTemplate
            .returns(
                '<html>' +
                '<body>' +
                '<fragment async=false primary id="f-1" src="https://fragment/no">' +
                '</body>' +
                '</html>'
            );

        const contextObj = {
            'f-1' : {
                src : 'https://fragment/yes',
                primary: false,
                async: true
            }
        };
        mockContext.returns(Promise.resolve(contextObj));

        http.get('http://localhost:8080/test', (response) => {
            let result = '';
            assert.equal(response.statusCode, 200);
            response.on('data', (data) => {
                result += data;
            });
            response.on('end', () => {
                assert.equal(
                    result,
                    '<html>' +
                    '<body>' +
                    '<script data-pipe>p.placeholder(0)</script>' +
                    '<script data-pipe>p.start(0)</script>' +
                    'yes' +
                    '<script data-pipe>p.end(0)</script>' +
                    '</body>' +
                    '</html>'
                );

                // Second request
                mockContext.returns(Promise.resolve({}));
                mockTemplate.returns(cacheTemplate.args[0][0]);

                http.get('http://localhost:8080/test', (response) => {
                    let result = '';
                    assert.equal(response.statusCode, 200);
                    response.on('data', (data) => {
                        result += data;
                    });
                    response.on('end', () => {
                        assert.equal(
                            result,
                            '<html>' +
                            '<body>' +
                            '<script data-pipe>p.placeholder(0)</script>' +
                            '<script data-pipe>p.start(0)</script>' +
                            'no' +
                            '<script data-pipe>p.end(0)</script>' +
                            '</body>' +
                            '</html>'
                        );
                        done();
                    });
                });
            });
        });
    });


});
