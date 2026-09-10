// SPDX-License-Identifier: BSL-1.0
// Narrow source-bound coverage helper; exact certificates use original rings.
#include <clipper2/clipper.h>
#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
using namespace Clipper2Lib;
using I=__int128;
constexpr size_t MAX_INPUT=8*1024*1024,MAX_OUTPUT=16*1024*1024,MAX_OUTPUT_VERTICES=65536;
constexpr int64_t BOUND=2000000000LL;
struct Group{Paths64 rings;};
struct Route{Point64 a,b;int64_t width,margin;};
struct Edge{Point64 a,b;};
std::string echo;
std::string base64(const std::string&s){const char*t="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";std::string o;for(size_t i=0;i<s.size();i+=3){uint32_t v=uint8_t(s[i])<<16;if(i+1<s.size())v|=uint8_t(s[i+1])<<8;if(i+2<s.size())v|=uint8_t(s[i+2]);o+=t[(v>>18)&63];o+=t[(v>>12)&63];o+=i+1<s.size()?t[(v>>6)&63]:'=';o+=i+2<s.size()?t[v&63]:'=';}return o;}
struct Parser{std::istringstream in;size_t vertices=0,rings=0;explicit Parser(const std::string&s):in(s){}
 std::string token(){std::string s;if(!(in>>s)||s.size()>48)throw std::runtime_error("invalid_token");return s;}
 void word(const char*s){if(token()!=s)throw std::runtime_error("invalid_keyword");}
 int64_t integer(){auto s=token();int64_t n;auto r=std::from_chars(s.data(),s.data()+s.size(),n);if(r.ec!=std::errc()||r.ptr!=s.data()+s.size())throw std::runtime_error("invalid_integer");return n;}
 size_t count(size_t min,size_t max){auto n=integer();if(n<int64_t(min)||n>int64_t(max))throw std::runtime_error("count_limit");return size_t(n);}
 int64_t coord(){auto n=integer();if(n < -BOUND||n>BOUND)throw std::runtime_error("coordinate_limit");return n;}
};
size_t predicateWork=0;
I orient(Point64 a,Point64 b,Point64 c){if(++predicateWork>20000000)throw std::runtime_error("predicate_work_limit");return I(b.x-a.x)*(c.y-a.y)-I(b.y-a.y)*(c.x-a.x);}
bool on(Point64 p,Point64 a,Point64 b){return orient(a,b,p)==0&&p.x>=std::min(a.x,b.x)&&p.x<=std::max(a.x,b.x)&&p.y>=std::min(a.y,b.y)&&p.y<=std::max(a.y,b.y);}
int sign(I x){return (x>0)-(x<0);}
bool intersects(Edge a,Edge b){I p=orient(a.a,a.b,b.a),q=orient(a.a,a.b,b.b),r=orient(b.a,b.b,a.a),s=orient(b.a,b.b,a.b);if(p==0&&on(b.a,a.a,a.b))return true;if(q==0&&on(b.b,a.a,a.b))return true;if(r==0&&on(a.a,b.a,b.b))return true;if(s==0&&on(a.b,b.a,b.b))return true;return sign(p)*sign(q)<0&&sign(r)*sign(s)<0;}
Point64 twice(Point64 a){return {a.x*2,a.y*2};}
// -1 boundary, 0 outside, 1 inside. Query and vertices use doubled-nm integers.
int ringLocation(const Path64&ring,Point64 p){int winding=0;for(size_t i=0;i<ring.size();++i){auto a=twice(ring[i]),b=twice(ring[(i+1)%ring.size()]);if(on(p,a,b))return -1;if(a.y<=p.y){if(b.y>p.y&&orient(a,b,p)>0)++winding;}else if(b.y<=p.y&&orient(a,b,p)<0)--winding;}return winding!=0?1:0;}
int location(const std::vector<Group>&groups,Point64 p){bool boundary=false;for(auto&g:groups){int outer=ringLocation(g.rings[0],p);if(outer<0){boundary=true;continue;}if(!outer)continue;bool hole=false,edge=false;for(size_t i=1;i<g.rings.size();++i){int z=ringLocation(g.rings[i],p);hole|=z==1;edge|=z<0;}if(!hole&&!edge)return 1;if(edge)boundary=true;}return boundary?-1:0;}
// Exact opposite directed edges cancel only within the same ring.
std::vector<Edge> boundaries(const std::vector<Group>&groups){std::vector<Edge> out;for(auto&g:groups)for(auto&r:g.rings){std::map<std::array<int64_t,4>,size_t> edges;for(size_t i=0;i<r.size();++i){auto a=r[i],b=r[(i+1)%r.size()];std::array<int64_t,4> key{a.x,a.y,b.x,b.y},rev{b.x,b.y,a.x,a.y};auto it=edges.find(rev);if(it!=edges.end()){if(--it->second==0)edges.erase(it);}else ++edges[key];}for(auto&kv:edges)out.push_back({twice({kv.first[0],kv.first[1]}),twice({kv.first[2],kv.first[3]})});}return out;}
Path64 hull(Path64 pts){std::sort(pts.begin(),pts.end(),[](auto a,auto b){return a.x<b.x||(a.x==b.x&&a.y<b.y);});pts.erase(std::unique(pts.begin(),pts.end(),[](auto a,auto b){return a.x==b.x&&a.y==b.y;}),pts.end());if(pts.size()<3)return {};Path64 h;for(auto p:pts){while(h.size()>1&&orient(h[h.size()-2],h.back(),p)<=0)h.pop_back();h.push_back(p);}auto k=h.size();for(auto i=pts.rbegin()+1;i!=pts.rend();++i){while(h.size()>k&&orient(h[h.size()-2],h.back(),*i)<=0)h.pop_back();h.push_back(*i);}h.pop_back();return h;}
Path64 envelope(const Route&r,bool outer){int64_t diameter=r.width+2*r.margin,rad=outer?(diameter+1)/2:diameter/2;Path64 pts;for(auto p:{r.a,r.b}){if(outer)for(auto dx:{-rad,rad})for(auto dy:{-rad,rad})pts.push_back({p.x+dx,p.y+dy});else{pts.push_back({p.x+rad,p.y});pts.push_back({p.x-rad,p.y});pts.push_back({p.x,p.y+rad});pts.push_back({p.x,p.y-rad});}}return hull(pts);}
bool inConvex(const Path64&h,Point64 p,bool strict){if(h.size()<3)return false;for(size_t i=0;i<h.size();++i){auto z=orient(twice(h[i]),twice(h[(i+1)%h.size()]),p);if(strict?z<=0:z<0)return false;}return true;}
bool certificate(const Path64&outer,const std::vector<Group>&groups,const std::vector<Edge>&edges){if(outer.empty()||location(groups,twice(outer[0]))!=1)return false;for(auto e:edges){if(inConvex(outer,e.a,false)||inConvex(outer,e.b,false))return false;for(size_t j=0;j<outer.size();++j)if(intersects(e,{twice(outer[j]),twice(outer[(j+1)%outer.size()])}))return false;}return true;}
Paths64 boolean(ClipType type,const Paths64&a,const Paths64&b={}){Clipper64 c;c.AddSubject(a);if(!b.empty())c.AddClip(b);Paths64 out;if(!c.Execute(type,FillRule::NonZero,out))throw std::runtime_error("clipper_failure");size_t n=0;for(auto&p:out)n+=p.size();if(n>MAX_OUTPUT_VERTICES)throw std::runtime_error("geometry_output_limit");return out;}
Paths64 normalized(const std::vector<Group>&groups){Paths64 all;for(auto&g:groups){auto copper=boolean(ClipType::Union,{g.rings[0]});Paths64 holes;for(size_t i=1;i<g.rings.size();++i){auto h=boolean(ClipType::Union,{g.rings[i]});holes.insert(holes.end(),h.begin(),h.end());}if(!holes.empty())copper=boolean(ClipType::Difference,copper,boolean(ClipType::Union,holes));all.insert(all.end(),copper.begin(),copper.end());}return boolean(ClipType::Union,all);}
size_t outputVertices=0;
void paths(std::ostream&o,const Paths64&p){o<<'[';bool f=true;for(auto&r:p){outputVertices+=r.size();if(outputVertices>MAX_OUTPUT_VERTICES)throw std::runtime_error("geometry_output_limit");if(!f)o<<',';f=false;o<<'[';bool q=true;for(auto v:r){if(!q)o<<',';q=false;o<<'['<<v.x<<','<<v.y<<']';}o<<']';}o<<']';}
bool witness(const Path64&inner,const Paths64&missing,const Route&r,const std::vector<Group>&groups,Point64&found){std::vector<Point64> candidates{{r.a.x+r.b.x,r.a.y+r.b.y}};for(auto&p:missing){if(p.empty())continue;int64_t minx=p[0].x,maxx=minx,miny=p[0].y,maxy=miny;for(auto q:p){candidates.push_back(twice(q));minx=std::min(minx,q.x);maxx=std::max(maxx,q.x);miny=std::min(miny,q.y);maxy=std::max(maxy,q.y);}candidates.push_back({minx+maxx,miny+maxy});}for(auto q:candidates)if(inConvex(inner,q,true)&&location(groups,q)==0){found=q;return true;}return false;}
const char*identity="\"schemaVersion\":1,\"implementationRevision\":\"evleda-reference-coverage-v1\",\"sourceCommit\":\"146a4f2a7585c65bc580427a19b6fe2ec4a3f622\",\"clipperVersion\":\"1.3.0\"";
int main(int argc,char**argv){try{
 if(argc!=3||std::string(argv[1])!="--input")throw std::runtime_error("invalid_arguments");
 std::ifstream file(std::filesystem::u8path(argv[2]),std::ios::binary);if(!file)throw std::runtime_error("input_unreadable");std::string input(MAX_INPUT+1,'\0');file.read(input.data(),input.size());input.resize(size_t(file.gcount()));if(input.size()>MAX_INPUT)throw std::runtime_error("input_byte_limit");if(file.bad())throw std::runtime_error("input_read_failed");echo=base64(input);
 for(unsigned char c:input)if(!((c>=32&&c<=126)||c=='\n'||c=='\r'||c=='\t'))throw std::runtime_error("input_not_ascii");
 Parser p(input);p.word("EVLEDA_REFERENCE_COVERAGE");if(p.integer()!=1)throw std::runtime_error("unsupported_input_version");p.word("GROUPS");size_t count=p.count(0,128);std::vector<Group>groups;
 for(size_t i=0;i<count;++i){p.word("GROUP");size_t nr=p.count(1,512);p.rings+=nr;if(p.rings>512)throw std::runtime_error("ring_limit");Group g;for(size_t j=0;j<nr;++j){p.word("RING");size_t nv=p.count(3,8192);p.vertices+=nv;if(p.vertices>8192)throw std::runtime_error("vertex_limit");Path64 r;for(size_t k=0;k<nv;++k){int64_t x=p.coord(),y=p.coord();r.push_back({x,y});}if(r.front()==r.back())throw std::runtime_error("repeated_closing_vertex");for(size_t k=0;k<r.size();++k)if(r[k]==r[(k+1)%r.size()])throw std::runtime_error("zero_length_ring_edge");I signedArea=0;for(size_t k=0;k<r.size();++k)signedArea+=I(r[k].x)*r[(k+1)%r.size()].y-I(r[k].y)*r[(k+1)%r.size()].x;if(signedArea==0)throw std::runtime_error("degenerate_ring");g.rings.push_back(r);}groups.push_back(g);}
 p.word("ROUTES");size_t nr=p.count(1,64);std::vector<Route>routes;for(size_t i=0;i<nr;++i){p.word("ROUTE");Route r;int64_t x=p.coord(),y=p.coord();r.a={x,y};x=p.coord();y=p.coord();r.b={x,y};r.width=p.integer();r.margin=p.integer();if(r.a==r.b)throw std::runtime_error("zero_length_route");if(r.width<=0||r.width>BOUND||r.margin<0||r.margin>BOUND)throw std::runtime_error("invalid_width_margin");auto outer=envelope(r,true);for(auto q:outer)if(q.x < -BOUND||q.x>BOUND||q.y < -BOUND||q.y>BOUND)throw std::runtime_error("envelope_coordinate_limit");routes.push_back(r);}p.word("END");std::string trailing;if(p.in>>trailing)throw std::runtime_error("trailing_input");
 auto copper=normalized(groups);auto edges=boundaries(groups);std::ostringstream out;out<<'{'<<identity<<",\"inputBase64\":\""<<echo<<"\",\"coordinateUnit\":\"nm\",\"normalizedCopper\":";paths(out,copper);out<<",\"routes\":[";
 for(size_t i=0;i<routes.size();++i){auto&r=routes[i];auto outer=envelope(r,true),inner=envelope(r,false);auto missing=boolean(ClipType::Difference,{outer},copper);Point64 w;bool covered=certificate(outer,groups,edges),uncovered=!covered&&witness(inner,missing,r,groups,w);if(i)out<<',';out<<"{\"routeIndex\":"<<i<<",\"status\":\""<<(covered?"covered":uncovered?"uncovered":"boundary_uncertain")<<"\",\"certificate\":\""<<(covered?"exact_outer_envelope_containment":uncovered?"exact_inner_envelope_outside_witness":"no_exact_certificate")<<"\",\"innerEnvelope\":";paths(out,{inner});out<<",\"outerEnvelope\":";paths(out,{outer});out<<",\"uncoveredOuterEnvelope\":";paths(out,missing);if(uncovered)out<<",\"outsideWitnessDoubledNm\":["<<w.x<<','<<w.y<<']';out<<'}';}
 out<<"],\"diagnosticGeometry\":\"clipper_integer_quantized_not_a_continuous_geometry_proof\",\"envelopeModel\":\"inner_L1_diamond_floor_radius_outer_Linf_square_ceil_radius\",\"coverageMeaning\":\"closed_Euclidean_segment_ribbon_radius_width_over_two_plus_margin\",\"dcConnectivityClaimed\":false,\"hfElectricalValidityClaimed\":false}";auto result=out.str();if(result.size()>MAX_OUTPUT)throw std::runtime_error("output_byte_limit");std::cout<<result<<'\n';return 0;
 }catch(const std::exception&e){std::string code=e.what();if(code.empty()||code.size()>64||code.find_first_not_of("abcdefghijklmnopqrstuvwxyz_")!=std::string::npos)code="internal_error";std::cout<<'{'<<identity<<",\"error\":\""<<code<<"\",\"inputBase64\":\""<<echo<<"\"}\n";return 1;}}
