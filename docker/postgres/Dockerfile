FROM postgres:18.4-alpine AS builder

RUN apk add --no-cache build-base curl autoconf automake libtool pkgconf

# 固定源码提交；不跟随上游 main/master 漂移。
ARG SCWS_REV=a04ef5e655213eb6b07fb57761d0eac72c281ad4
ARG ZHPARSER_REV=2e995c4df672563992b4d7a147b8fa2d0d4cda6c
ARG PGVECTOR_REV=8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c
ARG PGTEXTSEARCH_REV=7a932505b537d50ad8d2d068a053cd1dd7b646ea

WORKDIR /build
RUN curl -fsSL https://codeload.github.com/hightman/scws/tar.gz/${SCWS_REV} | tar xz --strip-components=1 \
    && autoreconf -fi && ./configure --prefix=/usr/local \
    && make -j2 && make install

WORKDIR /build/zhparser
RUN curl -fsSL https://codeload.github.com/amutu/zhparser/tar.gz/${ZHPARSER_REV} | tar xz --strip-components=1 \
    && make -j2 with_llvm=no && make install with_llvm=no

WORKDIR /build/pgvector
RUN curl -fsSL https://codeload.github.com/pgvector/pgvector/tar.gz/${PGVECTOR_REV} | tar xz --strip-components=1 \
    && make -j2 with_llvm=no OPTFLAGS="" && make install with_llvm=no

WORKDIR /build/pg_textsearch
RUN curl -fsSL https://codeload.github.com/timescale/pg_textsearch/tar.gz/${PGTEXTSEARCH_REV} | tar xz --strip-components=1 \
    && make -j2 with_llvm=no && make install with_llvm=no

FROM postgres:18.4-alpine
COPY --from=builder /usr/local/lib/ /usr/local/lib/
COPY --from=builder /usr/local/share/postgresql/ /usr/local/share/postgresql/
